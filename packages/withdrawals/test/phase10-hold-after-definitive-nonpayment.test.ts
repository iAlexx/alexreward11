/**
 * Real-chain DNP hold bridge — RECONCILE_REQUIRED → HELD (held_from_reconcile=true).
 * Zero ledger / sign / broadcast / reject / release.
 */
import { createHash, randomUUID } from 'node:crypto';

import { deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
  decideWithdrawal,
  HOLD_AFTER_DEFINITIVE_NONPAYMENT_ACTION,
  holdReconciledWithdrawalAfterDefinitiveNonpayment,
  localWithdrawalEngineFixtureConfig,
  WithdrawalDomainError,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createOwnerAdmin,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  fundUserAvailable,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_PUBLIC_KEY_HEX = '33'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});
const PAYOUT_JETTON_WALLET = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const QUERY_ID = '6345071293';
const GROSS = '200000';
const NORM_HASH = '50'.repeat(32);
const CELL_HASH = 'bd'.repeat(32);

describe.skipIf(phase7DatabaseUrl === '')(
  'phase10 hold after definitive nonpayment (real-chain bridge)',
  () => {
    let pool: Pool;
    let assetId: string;
    let networkId: string;
    let adminUserId: string;
    let hotWalletId: string;
    const engine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

    beforeAll(async () => {
      await resetAndMigrate(phase7DatabaseUrl);
      pool = new Pool({ connectionString: phase7DatabaseUrl });
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    beforeEach(async () => {
      await truncateWithdrawalTables(pool);
      const base = await seedPhase7Base(pool);
      assetId = base.assetId;
      networkId = base.networkId;
      adminUserId = await createOwnerAdmin(pool, `dnp-hold-${Date.now()}@example.local`);
      hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
        networkId,
        address: HOT_WALLET_RAW,
        friendlyAddress: HOT_WALLET_RAW,
        signerReference: ENCRYPTED_SIGNER_REF,
        payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
      });
      await pool.query(
        `UPDATE feature_flags SET enabled = true, updated_at = now()
         WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
      );
    });

    async function seedReconcileRequired(): Promise<{
      withdrawalId: string;
      attemptId: string;
      userId: string;
    }> {
      const userId = await createTestUser(
        pool,
        String(9_200_000_000 + Math.floor(Math.random() * 1e6)),
      );
      await createVerifiedPrimaryWallet(pool, {
        userId,
        networkId,
        rawAddress: RECIPIENT_RAW,
      });
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: GROSS,
        engineConfig: engine,
      });
      await pool.query(
        `UPDATE withdrawals
         SET state = 'RECONCILE_REQUIRED'::withdrawal_state, updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId],
      );
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO withdrawal_attempts (
           withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
           valid_until, canonical_message_hash, signer_key_reference,
           dispatch_fencing_token, broadcast_result_state, broadcast_ambiguity_class,
           requires_state_init, signed_external_message_boc,
           normalized_external_message_hash, external_message_cell_hash,
           signing_started_at, broadcast_started_at, broadcast_submitted_at
         ) VALUES (
           $1::uuid, 1, $2::uuid, 71, $3::bigint,
           now() - interval '1 hour', $4, $5,
           1, 'UNKNOWN', 'UNKNOWN_SUBMIT_OUTCOME',
           false, 'te6cckEBAQEAAgAAAA==',
           $6, $7,
           now(), now(), now()
         )
         RETURNING id`,
        [
          withdrawalId,
          hotWalletId,
          QUERY_ID,
          '04'.repeat(32),
          ENCRYPTED_SIGNER_REF,
          NORM_HASH,
          CELL_HASH,
        ],
      );
      return { withdrawalId, attemptId: attempt.rows[0]!.id, userId };
    }

    async function insertReconciliation(input: {
      withdrawalId: string;
      attemptId: string;
      resolution: 'DEFINITIVE_NONPAYMENT' | 'AMBIGUOUS' | 'INTENDED_PAYOUT_PROVEN';
      reason?: string | null;
      evidenceExtra?: Record<string, unknown>;
    }): Promise<string> {
      const evidence: Record<string, unknown> = {
        reconcileOnly: true,
        ...(input.reason !== null && input.reason !== undefined
          ? { reason: input.reason }
          : {}),
        ...input.evidenceExtra,
      };
      const row = await pool.query<{ id: string }>(
        `INSERT INTO withdrawal_payout_reconciliations (
           withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary, resolved_at
         ) VALUES ($1::uuid, $2::uuid, $3::withdrawal_payout_reconcile_resolution, $4::jsonb, now())
         RETURNING id`,
        [input.withdrawalId, input.attemptId, input.resolution, JSON.stringify(evidence)],
      );
      return row.rows[0]!.id;
    }

    async function insertSecondAttempt(withdrawalId: string, firstAttemptId: string): Promise<string> {
      // Release one-active unique index so a second attempt row can exist.
      await pool.query(
        `UPDATE withdrawal_attempts
         SET broadcast_result_state = 'BROADCASTED'::withdrawal_attempt_result,
             updated_at = now()
         WHERE id = $1::uuid`,
        [firstAttemptId],
      );
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO withdrawal_attempts (
           withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
           valid_until, canonical_message_hash, signer_key_reference,
           dispatch_fencing_token, broadcast_result_state, broadcast_ambiguity_class,
           requires_state_init, signed_external_message_boc,
           normalized_external_message_hash, external_message_cell_hash,
           signing_started_at, broadcast_started_at, broadcast_submitted_at
         ) VALUES (
           $1::uuid, 2, $2::uuid, 72, $3::bigint,
           now() - interval '1 hour', $4, $5,
           2, 'UNKNOWN', 'UNKNOWN_SUBMIT_OUTCOME',
           false, 'te6cckEBAQEAAgAAAA==',
           $6, $7,
           now(), now(), now()
         )
         RETURNING id`,
        [
          withdrawalId,
          hotWalletId,
          '6345071294',
          '05'.repeat(32),
          ENCRYPTED_SIGNER_REF,
          '51'.repeat(32),
          'be'.repeat(32),
        ],
      );
      return attempt.rows[0]!.id;
    }

    async function withdrawalFlags(withdrawalId: string): Promise<{
      state: string;
      heldFromReconcile: boolean;
      settlement: string | null;
      confirmedAt: Date | null;
    }> {
      const r = await pool.query<{
        state: string;
        held_from_reconcile: boolean;
        settlement: string | null;
        confirmed_at: Date | null;
      }>(
        `SELECT state::text AS state, held_from_reconcile,
                settlement_ledger_tx_id::text AS settlement, confirmed_at
         FROM withdrawals WHERE id = $1::uuid`,
        [withdrawalId],
      );
      const row = r.rows[0]!;
      return {
        state: row.state,
        heldFromReconcile: row.held_from_reconcile,
        settlement: row.settlement,
        confirmedAt: row.confirmed_at,
      };
    }

    async function ledgerTxCount(): Promise<number> {
      const r = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ledger_transactions`);
      return Number(r.rows[0]?.c ?? 0);
    }

    async function attemptCount(withdrawalId: string): Promise<number> {
      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      );
      return Number(r.rows[0]?.c ?? 0);
    }

    async function auditCount(withdrawalId: string): Promise<number> {
      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM audit_logs
         WHERE resource_id = $1::uuid AND action_type = $2`,
        [withdrawalId, HOLD_AFTER_DEFINITIVE_NONPAYMENT_ACTION],
      );
      return Number(r.rows[0]?.c ?? 0);
    }

    async function outboxCount(withdrawalId: string): Promise<number> {
      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM outbox_events WHERE aggregate_id = $1::uuid`,
        [withdrawalId],
      );
      return Number(r.rows[0]?.c ?? 0);
    }

    it('1 VALID DNP → HELD + held_from_reconcile=true', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      const reconciliationId = await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });

      const result = await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        reconciliationId,
        idempotencyKey: randomUUID(),
        trustedOwnerActorContext: { adminUserId },
      });

      expect(result.state).toBe('HELD');
      expect(result.heldFromReconcile).toBe(true);
      expect(result.transitioned).toBe(true);
      expect(result.alreadyApplied).toBe(false);
      expect(result.reconciliationId).toBe(reconciliationId);
      expect(result.definitiveNonpaymentReason).toBe(
        DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      );

      const flags = await withdrawalFlags(withdrawalId);
      expect(flags.state).toBe('HELD');
      expect(flags.heldFromReconcile).toBe(true);
    });

    it('2 RESERVED + Available unchanged (zero ledger posting)', async () => {
      const { withdrawalId, attemptId, userId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      const availableBefore = await userBucketBalance(
        pool,
        userId,
        assetId,
        'USER_AVAILABLE_LIABILITY',
      );
      const reservedBefore = await userBucketBalance(
        pool,
        userId,
        assetId,
        'USER_RESERVED_LIABILITY',
      );
      expect(reservedBefore).toBe(200000n);
      const ledgerBefore = await ledgerTxCount();

      await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        idempotencyKey: randomUUID(),
        trustedOwnerActorContext: { adminUserId },
      });

      expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
        availableBefore,
      );
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        reservedBefore,
      );
      expect(await ledgerTxCount()).toBe(ledgerBefore);
    });

    it('3 ONLY AMBIGUOUS → fail closed, state unchanged', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'AMBIGUOUS',
        reason: null,
      });

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      const flags = await withdrawalFlags(withdrawalId);
      expect(flags.state).toBe('RECONCILE_REQUIRED');
      expect(flags.heldFromReconcile).toBe(false);
    });

    it('4 NO RECONCILIATION → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      expect((await withdrawalFlags(withdrawalId)).state).toBe('RECONCILE_REQUIRED');
    });

    it('5 WRONG / unsupported DNP reason → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: 'SOME_UNSUPPORTED_REASON',
      });

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      expect((await withdrawalFlags(withdrawalId)).heldFromReconcile).toBe(false);
    });

    it('6 DNP for wrong attempt → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      const otherAttemptId = await insertSecondAttempt(withdrawalId, attemptId);
      const reconciliationId = await insertReconciliation({
        withdrawalId,
        attemptId: otherAttemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          reconciliationId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      expect((await withdrawalFlags(withdrawalId)).state).toBe('RECONCILE_REQUIRED');
    });

    it('7 INTENDED_PAYOUT_PROVEN also exists → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'INTENDED_PAYOUT_PROVEN',
        reason: null,
      });

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      expect((await withdrawalFlags(withdrawalId)).state).toBe('RECONCILE_REQUIRED');
    });

    it('8 SETTLEMENT EXISTS → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      const tx = await pool.query<{ id: string }>(
        `INSERT INTO ledger_transactions (
           transaction_type, business_reference_type, business_reference_id,
           idempotency_scope, idempotency_key, asset_id, created_by_type
         ) VALUES (
           'WITHDRAWAL_SETTLEMENT', 'withdrawal', $1::uuid,
           $2, 'settlement-hold-bridge-guard', $3::uuid, 'SYSTEM'
         )
         RETURNING id`,
        [withdrawalId, `settlement-hold-bridge:${withdrawalId}`, assetId],
      );
      const settlementId = tx.rows[0]?.id;
      if (settlementId === undefined) {
        throw new Error('settlement ledger_transactions insert failed');
      }
      await pool.query(
        `UPDATE withdrawals SET settlement_ledger_tx_id = $2::uuid WHERE id = $1::uuid`,
        [withdrawalId, settlementId],
      );

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' } satisfies Partial<WithdrawalDomainError>);
    });

    it('9 CONFIRMED withdrawal → fail closed', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      await pool.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED'::withdrawal_state, confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId],
      );

      await expect(
        holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
          withdrawalId,
          attemptId,
          idempotencyKey: randomUUID(),
          trustedOwnerActorContext: { adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' } satisfies Partial<WithdrawalDomainError>);
    });

    it('10 WRONG START STATE (APPROVED / QUEUED / HELD) → fail closed', async () => {
      // APPROVED
      {
        const userId = await createTestUser(pool, String(9_210_000_000 + Math.floor(Math.random() * 1e5)));
        await createVerifiedPrimaryWallet(pool, { userId, networkId, rawAddress: RECIPIENT_RAW });
        const withdrawalId = await createApprovedWithdrawal(pool, {
          userId,
          networkId,
          assetId,
          adminUserId,
          hotWalletId,
          amountAtomic: GROSS,
          engineConfig: engine,
        });
        const attempt = await pool.query<{ id: string }>(
          `INSERT INTO withdrawal_attempts (
             withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
             valid_until, canonical_message_hash, signer_key_reference,
             dispatch_fencing_token, broadcast_result_state, requires_state_init,
             signed_external_message_boc, normalized_external_message_hash, external_message_cell_hash
           ) VALUES (
             $1::uuid, 1, $2::uuid, 1, 1,
             now(), $3, $4, 1, 'PENDING', false,
             'te6cckEBAQEAAgAAAA==', $5, $6
           ) RETURNING id`,
          [withdrawalId, hotWalletId, '06'.repeat(32), ENCRYPTED_SIGNER_REF, NORM_HASH, CELL_HASH],
        );
        const attemptId = attempt.rows[0]!.id;
        await insertReconciliation({
          withdrawalId,
          attemptId,
          resolution: 'DEFINITIVE_NONPAYMENT',
          reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
        });
        await expect(
          holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
            withdrawalId,
            attemptId,
            idempotencyKey: randomUUID(),
            trustedOwnerActorContext: { adminUserId },
          }),
        ).rejects.toMatchObject({ code: 'STATE_CONFLICT' } satisfies Partial<WithdrawalDomainError>);
        expect((await withdrawalFlags(withdrawalId)).state).toBe('APPROVED');
      }

      // QUEUED
      {
        const { withdrawalId, attemptId } = await seedReconcileRequired();
        await insertReconciliation({
          withdrawalId,
          attemptId,
          resolution: 'DEFINITIVE_NONPAYMENT',
          reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
        });
        await pool.query(
          `UPDATE withdrawals SET state = 'QUEUED'::withdrawal_state, queued_at = now() WHERE id = $1::uuid`,
          [withdrawalId],
        );
        await expect(
          holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
            withdrawalId,
            attemptId,
            idempotencyKey: randomUUID(),
            trustedOwnerActorContext: { adminUserId },
          }),
        ).rejects.toMatchObject({ code: 'STATE_CONFLICT' } satisfies Partial<WithdrawalDomainError>);
      }

      // Normal HELD (held_from_reconcile=false) — refuse silent upgrade
      {
        const userId = await createTestUser(pool, String(9_220_000_000 + Math.floor(Math.random() * 1e5)));
        await createVerifiedPrimaryWallet(pool, { userId, networkId, rawAddress: RECIPIENT_RAW });
        await fundUserAvailable({
          pool,
          userId,
          assetId,
          amountAtomic: '500000',
          key: randomUUID(),
        });
        const { withdrawalId } = await quoteAndCreate(pool, userId, GROSS, randomUUID(), engine);
        await decideWithdrawal(pool, engine, {
          withdrawalId,
          expectedState: 'MANUAL_REVIEW',
          decision: 'HOLD',
          trustedOwnerActorContext: { adminUserId },
          reason: 'normal-hold',
          idempotencyKey: randomUUID(),
        });
        const attempt = await pool.query<{ id: string }>(
          `INSERT INTO withdrawal_attempts (
             withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
             valid_until, canonical_message_hash, signer_key_reference,
             dispatch_fencing_token, broadcast_result_state, requires_state_init,
             signed_external_message_boc, normalized_external_message_hash, external_message_cell_hash
           ) VALUES (
             $1::uuid, 1, $2::uuid, 1, 2,
             now(), $3, $4, 1, 'PENDING', false,
             'te6cckEBAQEAAgAAAA==', $5, $6
           ) RETURNING id`,
          [withdrawalId, hotWalletId, '07'.repeat(32), ENCRYPTED_SIGNER_REF, NORM_HASH, CELL_HASH],
        );
        const attemptId = attempt.rows[0]!.id;
        await insertReconciliation({
          withdrawalId,
          attemptId,
          resolution: 'DEFINITIVE_NONPAYMENT',
          reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
        });
        await expect(
          holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
            withdrawalId,
            attemptId,
            idempotencyKey: randomUUID(),
            trustedOwnerActorContext: { adminUserId },
          }),
        ).rejects.toMatchObject({ code: 'STATE_CONFLICT' } satisfies Partial<WithdrawalDomainError>);
        expect((await withdrawalFlags(withdrawalId)).heldFromReconcile).toBe(false);
      }
    });

    it('11 IDEMPOTENT REPLAY — no duplicate mutation/audit', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      const reconciliationId = await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      const key = randomUUID();
      const first = await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        reconciliationId,
        idempotencyKey: key,
        trustedOwnerActorContext: { adminUserId },
      });
      expect(first.transitioned).toBe(true);
      expect(await auditCount(withdrawalId)).toBe(1);

      const second = await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        reconciliationId,
        idempotencyKey: key,
        trustedOwnerActorContext: { adminUserId },
      });
      expect(second.alreadyApplied).toBe(true);
      expect(second.transitioned).toBe(false);
      expect(second.state).toBe('HELD');
      expect(await auditCount(withdrawalId)).toBe(1);
      expect(await attemptCount(withdrawalId)).toBe(1);
    });

    it('12–15 NO attempt / ledger / outbox mutation; works while paused', async () => {
      const pause = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags
         WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
      );
      expect(pause.rows[0]?.enabled).toBe(true);

      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      const attemptsBefore = await attemptCount(withdrawalId);
      const ledgerBefore = await ledgerTxCount();
      const outboxBefore = await outboxCount(withdrawalId);

      await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        idempotencyKey: randomUUID(),
        trustedOwnerActorContext: { adminUserId },
      });

      expect(await attemptCount(withdrawalId)).toBe(attemptsBefore);
      expect(await ledgerTxCount()).toBe(ledgerBefore);
      expect(await outboxCount(withdrawalId)).toBe(outboxBefore);
      expect((await withdrawalFlags(withdrawalId)).heldFromReconcile).toBe(true);
    });

    it('16 held_from_reconcile=true is set explicitly', async () => {
      const { withdrawalId, attemptId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      expect((await withdrawalFlags(withdrawalId)).heldFromReconcile).toBe(false);

      await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        idempotencyKey: randomUUID(),
        trustedOwnerActorContext: { adminUserId },
      });

      expect((await withdrawalFlags(withdrawalId)).heldFromReconcile).toBe(true);
    });

    it('17 normal Owner HOLD does not set held_from_reconcile', async () => {
      const userId = await createTestUser(pool, String(9_230_000_000 + Math.floor(Math.random() * 1e5)));
      await createVerifiedPrimaryWallet(pool, { userId, networkId, rawAddress: RECIPIENT_RAW });
      await fundUserAvailable({
        pool,
        userId,
        assetId,
        amountAtomic: '500000',
        key: randomUUID(),
      });
      const { withdrawalId } = await quoteAndCreate(pool, userId, GROSS, randomUUID(), engine);
      await decideWithdrawal(pool, engine, {
        withdrawalId,
        expectedState: 'MANUAL_REVIEW',
        decision: 'HOLD',
        trustedOwnerActorContext: { adminUserId },
        reason: 'ops-hold',
        idempotencyKey: randomUUID(),
      });
      const flags = await withdrawalFlags(withdrawalId);
      expect(flags.state).toBe('HELD');
      expect(flags.heldFromReconcile).toBe(false);
    });

    it('decideWithdrawal: reconcile-origin HELD still requires definitiveNonpayment; release path intact', async () => {
      const { withdrawalId, attemptId, userId } = await seedReconcileRequired();
      await insertReconciliation({
        withdrawalId,
        attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
      });
      await holdReconciledWithdrawalAfterDefinitiveNonpayment(pool, {
        withdrawalId,
        attemptId,
        idempotencyKey: randomUUID(),
        trustedOwnerActorContext: { adminUserId },
      });

      await expect(
        decideWithdrawal(pool, engine, {
          withdrawalId,
          expectedState: 'HELD',
          decision: 'REJECT',
          trustedOwnerActorContext: { adminUserId },
          reason: 'no-ack',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'TRANSITION_FORBIDDEN' } satisfies Partial<WithdrawalDomainError>);

      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        200000n,
      );

      await decideWithdrawal(pool, engine, {
        withdrawalId,
        expectedState: 'HELD',
        decision: 'REJECT',
        trustedOwnerActorContext: { adminUserId },
        reason: 'dnp-ack',
        idempotencyKey: randomUUID(),
        definitiveNonpayment: true,
      });

      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
      expect((await withdrawalFlags(withdrawalId)).state).toBe('REJECTED');
    });
  },
);
