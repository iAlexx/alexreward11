import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError } from '../src/index.js';
import {
  applyV1RiskPolicy,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  bindVerifiedPrimaryWallet,
  claimFounderForUser,
  createTestUser,
  engineConfig,
  fundUserAvailable,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedFounderPriorityReview,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 risk manual', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;

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
    adminUserId = base.adminUserId;
  });

  it('V1 never auto-approves — ordinary path lands in MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '7201');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { state } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    expect(state).toBe('MANUAL_REVIEW');
    const row = await pool.query<{ risk_decision: string; state: string }>(
      `SELECT risk_decision::text, state::text FROM withdrawals ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row.rows[0]?.risk_decision).toBe('MANUAL_REVIEW');
    expect(row.rows[0]?.state).not.toBe('APPROVED');
  });

  it('BLOCKED → REJECTED + release once (risk path after reservation)', async () => {
    const userId = await createTestUser(pool, '7202');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });

    // Build REQUESTED + reservation without wallet-gate BLOCKED check, then apply risk.
    const hot = await pool.query<{ id: string }>(
      `SELECT id FROM hot_wallets WHERE status = 'ACTIVE' LIMIT 1`,
    );
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO withdrawals (
         user_id, withdrawal_quote_id, asset_id, network_id, wallet_id,
         requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
         state, approval_policy_version, priority_review,
         idempotency_scope, idempotency_key,
         limit_rule_id, fee_rule_id, fee_rule_version, limit_rule_version,
         base_platform_fee_atomic, membership_fee_discount_bps, hot_wallet_id
       )
       SELECT
         $1::uuid, $2::uuid, asset_id, network_id, primary_wallet_id,
         requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
         'REQUESTED', 1, false,
         $3, $4,
         limit_rule_id, fee_rule_id, fee_rule_version, limit_rule_version,
         base_platform_fee_atomic, membership_fee_discount_bps, $5::uuid
       FROM withdrawal_quotes WHERE id = $2::uuid
       RETURNING id`,
      [userId, quote.id, `user:${userId}:withdrawal`, randomUUID(), hot.rows[0]!.id],
    );
    const withdrawalId = inserted.rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      const { getOrCreateLedgerAccount, postLedgerTransaction } =
        await import('@alex-rewards/ledger');
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const reserved = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_RESERVED_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const tx = await postLedgerTransaction(client, {
        transactionType: 'WITHDRAWAL_RESERVATION',
        businessReferenceType: 'withdrawal',
        businessReferenceId: withdrawalId,
        idempotencyScope: `withdrawal-reservation:${withdrawalId}`,
        idempotencyKey: 'reservation',
        assetId,
        entries: [
          { ledgerAccountId: available.id, direction: 'DEBIT', amountAtomic: '200000' },
          { ledgerAccountId: reserved.id, direction: 'CREDIT', amountAtomic: '200000' },
        ],
      });
      await client.query(
        `UPDATE withdrawals SET reservation_ledger_tx_id = $2::uuid WHERE id = $1::uuid`,
        [withdrawalId, tx.id],
      );
    });

    await pool.query(`UPDATE users SET withdrawal_status = 'BLOCKED' WHERE id = $1::uuid`, [
      userId,
    ]);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);

    const risk = await withWithdrawalTransaction(pool, async (client) =>
      applyV1RiskPolicy(client, engineConfig, {
        withdrawalId,
        userId,
        fromState: 'REQUESTED',
      }),
    );
    expect(risk.decision).toBe('WITHDRAWAL_BLOCKED');
    expect(risk.state).toBe('REJECTED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      500000n,
    );

    const release = await pool.query<{ release_ledger_tx_id: string | null }>(
      `SELECT release_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(release.rows[0]?.release_ledger_tx_id).not.toBeNull();

    // Release once: re-release is a no-op
    await withWithdrawalTransaction(pool, async (client) => {
      const { releaseWithdrawalReservation } = await import('../src/index.js');
      const second = await releaseWithdrawalReservation(client, { withdrawalId });
      expect(second.released).toBe(false);
    });
  });

  it('Owner APPROVE once; double approve 100x → one transition / one outbox', async () => {
    const userId = await createTestUser(pool, '7203');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());

    const key = randomUUID();
    const first = await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'APPROVE',
      trustedOwnerActorContext: { adminUserId },
      reason: 'ok',
      idempotencyKey: key,
    });
    expect(first.state).toBe('APPROVED');
    expect(first.workflowId).toBe(`withdrawal/${withdrawalId}`);

    const replays = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        decideWithdrawal(pool, engineConfig, {
          withdrawalId,
          expectedState: 'MANUAL_REVIEW',
          decision: 'APPROVE',
          trustedOwnerActorContext: { adminUserId },
          reason: 'ok',
          idempotencyKey: key,
        }),
      ),
    );
    for (const r of replays) {
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') {
        expect(r.value.approvalId).toBe(first.approvalId);
        expect(r.value.state).toBe('APPROVED');
      }
    }

    const outbox = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM outbox_events
       WHERE dedupe_key = $1`,
      [`withdrawal.approved:${withdrawalId}`],
    );
    expect(outbox.rows[0]?.c).toBe('1');

    const approvals = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawal_approvals WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(approvals.rows[0]?.c).toBe('1');
  });

  it('outbox event withdrawal.approved with workflow_id withdrawal/{id}', async () => {
    const userId = await createTestUser(pool, '7204');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'APPROVE',
      trustedOwnerActorContext: { adminUserId },
      reason: 'outbox',
      idempotencyKey: randomUUID(),
    });

    const outbox = await pool.query<{
      event_type: string;
      payload: { workflowId: string; withdrawalId: string };
    }>(
      `SELECT event_type, payload FROM outbox_events
       WHERE dedupe_key = $1`,
      [`withdrawal.approved:${withdrawalId}`],
    );
    expect(outbox.rows[0]?.event_type).toBe('withdrawal.approved');
    expect(outbox.rows[0]?.payload.workflowId).toBe(`withdrawal/${withdrawalId}`);
    expect(outbox.rows[0]?.payload.withdrawalId).toBe(withdrawalId);
  });

  it('HOLD works from MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '7205');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    const held = await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'HOLD',
      trustedOwnerActorContext: { adminUserId },
      reason: 'hold-me',
      idempotencyKey: randomUUID(),
    });
    expect(held.state).toBe('HELD');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('priority=true does not skip MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, '7206');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await withWithdrawalTransaction(pool, async (client) => {
      await seedFounderPriorityReview(client);
    });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    expect(quote.priorityReview).toBe(true);

    const w = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });
    expect(w.priorityReview).toBe(true);
    expect(w.state).toBe('MANUAL_REVIEW');
  });

  it('risk snapshot is immutable', async () => {
    const userId = await createTestUser(pool, '7207');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await quoteAndCreate(pool, userId, '200000', randomUUID());
    const snap = await pool.query<{ id: string }>(
      `SELECT risk_snapshot_id AS id FROM withdrawals WHERE risk_snapshot_id IS NOT NULL LIMIT 1`,
    );
    const snapshotId = snap.rows[0]?.id;
    expect(snapshotId).toBeTruthy();

    await expect(
      pool.query(`UPDATE risk_snapshots SET score = 1 WHERE id = $1::uuid`, [snapshotId]),
    ).rejects.toThrow();
    await expect(
      pool.query(`DELETE FROM risk_snapshots WHERE id = $1::uuid`, [snapshotId]),
    ).rejects.toThrow();
  });

  it('pre-broadcast reject from MANUAL_REVIEW releases once', async () => {
    const userId = await createTestUser(pool, '7208');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());

    await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'REJECT',
      trustedOwnerActorContext: { adminUserId },
      reason: 'pre-broadcast',
      idempotencyKey: randomUUID(),
    });

    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      500000n,
    );

    const row = await pool.query<{ state: string; release_ledger_tx_id: string | null }>(
      `SELECT state::text AS state, release_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(row.rows[0]?.state).toBe('REJECTED');
    expect(row.rows[0]?.release_ledger_tx_id).not.toBeNull();

    await expect(
      decideWithdrawal(pool, engineConfig, {
        withdrawalId,
        expectedState: 'REJECTED',
        decision: 'REJECT',
        trustedOwnerActorContext: { adminUserId },
        reason: 'again',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: /TRANSITION_FORBIDDEN|STATE_CONFLICT/ });
  });

  it('BLOCKED at quote time fails closed before create', async () => {
    const userId = await createTestUser(pool, '7209');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await pool.query(`UPDATE users SET withdrawal_status = 'BLOCKED' WHERE id = $1::uuid`, [
      userId,
    ]);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' } satisfies Partial<WithdrawalDomainError>);
  });
});
