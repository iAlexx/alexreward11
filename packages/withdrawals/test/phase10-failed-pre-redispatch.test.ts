import { createHash } from 'node:crypto';

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireHotWalletDispatchLease,
  buildPhase10PayoutConfig,
  enqueueFailedPreBroadcastRetry,
  evaluateFailedPreBroadcastReuse,
  hotWalletDispatchOwnerIdentity,
  localWithdrawalEngineFixtureConfig,
  processWithdrawalFailedPreRetryOutboxBatch,
  releaseHotWalletDispatchLease,
  runRealTestnetPayoutPipeline,
  WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT,
  WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
  withdrawalFailedPreRetryDedupeKey,
  withdrawalWorkflowId,
  withWithdrawalTransaction,
  type RealPayoutSignerPort,
  type TemporalWorkflowStarter,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const PAYOUT_JETTON_WALLET = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});
const nonFakeEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

describe.skipIf(phase7DatabaseUrl === '')('phase10 failed-pre Temporal redispatch', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;

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
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_failed_pre_redispatch',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]!.contract_identity;
  });

  function createTestSigner(): RealPayoutSignerPort {
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'n/a',
        };
      },
      async signWithdrawalAttempt() {
        throw new Error('sign must not be called in redispatch unit setup');
      },
    };
  }

  async function queueApprovedWithdrawal(telegramUserId: string): Promise<string> {
    const userId = await createTestUser(pool, telegramUserId);
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
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );
    return withdrawalId;
  }

  async function forceFailedPreZeroAttempts(withdrawalId: string): Promise<void> {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 5,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 5,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => {
        throw new Error('forced_pre_attempt_failure');
      },
    });
    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.attemptId).toBeNull();
  }

  function recordingStarter(input?: {
    readonly throwAlreadyStartedOn?: number;
    readonly runningDescribe?: boolean;
  }): TemporalWorkflowStarter & {
    readonly starts: Array<{
      workflowId: string;
      reusePolicy: string | undefined;
      conflictPolicy: string | undefined;
    }>;
  } {
    const starts: Array<{
      workflowId: string;
      reusePolicy: string | undefined;
      conflictPolicy: string | undefined;
    }> = [];
    let startCount = 0;
    return {
      starts,
      workflow: {
        async start(_type, options) {
          startCount += 1;
          starts.push({
            workflowId: options.workflowId,
            reusePolicy: options.workflowIdReusePolicy,
            conflictPolicy: options.workflowIdConflictPolicy,
          });
          if (
            input?.throwAlreadyStartedOn !== undefined &&
            startCount === input.throwAlreadyStartedOn
          ) {
            throw new WorkflowExecutionAlreadyStartedError(
              'already started',
              options.workflowId,
              WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
            );
          }
          return {};
        },
        getHandle(workflowId: string) {
          return {
            async describe() {
              void workflowId;
              if (input?.runningDescribe === true) {
                return { status: { name: 'RUNNING' } };
              }
              return { status: { name: 'COMPLETED' } };
            },
          };
        },
      },
    };
  }

  it('safe reuse: enqueue + relay starts same workflowId with ALLOW_DUPLICATE', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9901');
    await forceFailedPreZeroAttempts(withdrawalId);
    const reservationBefore = await pool.query<{
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
    }>(
      `SELECT reservation_ledger_tx_id, release_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const volumeBefore = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_volume_reservations WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );

    const enq = await enqueueFailedPreBroadcastRetry(pool, {
      withdrawalId,
      actorAdminUserId: adminUserId,
      reason: 'test-safe-reuse',
    });
    expect(enq.accepted).toBe(true);
    expect(enq.created).toBe(true);
    expect(enq.workflowId).toBe(withdrawalWorkflowId(withdrawalId));
    expect(enq.retryOrdinal).toBe(1);

    const starter = recordingStarter();
    const batch = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: starter,
      taskQueue: 'test-failed-pre-retry',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(batch).toMatchObject({ claimed: 1, dispatched: 1, retried: 0, deadLetter: 0 });
    expect(starter.starts).toHaveLength(1);
    expect(starter.starts[0]).toMatchObject({
      workflowId: withdrawalWorkflowId(withdrawalId),
      reusePolicy: 'ALLOW_DUPLICATE',
      conflictPolicy: 'FAIL',
    });

    const outbox = await pool.query<{ status: string; dedupe_key: string }>(
      `SELECT status::text AS status, dedupe_key FROM outbox_events WHERE id = $1::uuid`,
      [enq.outboxId],
    );
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');
    expect(outbox.rows[0]?.dedupe_key).toBe(
      withdrawalFailedPreRetryDedupeKey(withdrawalId, 1),
    );

    const after = await pool.query<{
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      public_id: string | null;
    }>(
      `SELECT reservation_ledger_tx_id, release_ledger_tx_id, public_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(
      reservationBefore.rows[0]?.reservation_ledger_tx_id,
    );
    expect(after.rows[0]?.release_ledger_tx_id).toBeNull();
    const volumeAfter = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_volume_reservations WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(volumeAfter.rows[0]?.c).toBe(volumeBefore.rows[0]?.c);
    const wdCount = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(wdCount.rows[0]?.c).toBe(1);
  });

  it('duplicate enqueue while PENDING is idempotent (no second outbox / reservation)', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9902');
    await forceFailedPreZeroAttempts(withdrawalId);

    const first = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    const second = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    expect(first.accepted).toBe(true);
    expect(first.created).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.created).toBe(false);
    expect(second.outboxId).toBe(first.outboxId);

    const rows = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE event_type = $1 AND aggregate_id = $2::uuid`,
      [WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT, withdrawalId],
    );
    expect(rows.rows[0]?.c).toBe(1);
  });

  it('duplicate relay delivery: AlreadyStarted marks DISPATCHED once', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9903');
    await forceFailedPreZeroAttempts(withdrawalId);
    await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });

    const starter = recordingStarter({ throwAlreadyStartedOn: 1 });
    const batch = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: starter,
      taskQueue: 'test-failed-pre-retry-dup',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(batch.dispatched).toBe(1);
    expect(batch.retried).toBe(0);
    expect(starter.starts).toHaveLength(1);

    const second = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: recordingStarter(),
      taskQueue: 'test-failed-pre-retry-dup',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(second.claimed).toBe(0);
  });

  it('RUNNING prior workflow is refused (DEAD_LETTER, no start)', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9904');
    await forceFailedPreZeroAttempts(withdrawalId);
    const enq = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });

    const starter = recordingStarter({ runningDescribe: true });
    const batch = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: starter,
      taskQueue: 'test-failed-pre-running',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(batch.deadLetter).toBe(1);
    expect(batch.dispatched).toBe(0);
    expect(starter.starts).toHaveLength(0);

    const row = await pool.query<{ status: string; last_error_redacted: string | null }>(
      `SELECT status::text AS status, last_error_redacted FROM outbox_events WHERE id = $1::uuid`,
      [enq.outboxId],
    );
    expect(row.rows[0]?.status).toBe('DEAD_LETTER');
    expect(row.rows[0]?.last_error_redacted).toMatch(/workflow_still_running/);
  });

  it('PENDING (non-failed-pre) attempt refuses enqueue and dead-letters staged outbox', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9905');
    await forceFailedPreZeroAttempts(withdrawalId);
    const enq = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    expect(enq.accepted).toBe(true);

    // Corrupt safety: insert a live PENDING attempt (ambiguous / non-failed-pre).
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init
       ) VALUES (
         $1::uuid, 1, $2::uuid, 1, 42,
         now() + interval '5 minutes', $3, $4,
         1, 'PENDING', false
       )`,
      [withdrawalId, hotWalletId, 'aa'.repeat(32), ENCRYPTED_SIGNER_REF],
    );

    const refused = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    expect(refused.accepted).toBe(false);
    expect(
      refused.refusalReasons.some(
        (r) => r.startsWith('non_failed_pre_attempts') || r.startsWith('ambiguous_chain_outcome'),
      ),
    ).toBe(true);

    const starter = recordingStarter();
    const batch = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: starter,
      taskQueue: 'test-failed-pre-unsafe',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);

    const evalNow = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalNow.ok).toBe(false);
  });

  async function insertCleanFailedPreAttempt(
    withdrawalId: string,
    attemptNumber: number,
  ): Promise<string> {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init
       ) VALUES (
         $1::uuid, $2, $3::uuid, 1, $4::bigint,
         now() + interval '5 minutes', $5, $6,
         1, 'FAILED_PRE_BROADCAST', false
       )
       RETURNING id::text AS id`,
      [
        withdrawalId,
        attemptNumber,
        hotWalletId,
        BigInt(4_000_000_000 + attemptNumber),
        'bb'.repeat(32),
        ENCRYPTED_SIGNER_REF,
      ],
    );
    return inserted.rows[0]!.id;
  }

  it('one prior clean FAILED_PRE_BROADCAST attempt allows enqueue (Attempt #2 path)', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9910');
    await forceFailedPreZeroAttempts(withdrawalId);
    await insertCleanFailedPreAttempt(withdrawalId, 1);

    const evalOk = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalOk.ok).toBe(true);
    expect(evalOk.snapshot?.attemptCount).toBe(1);
    expect(evalOk.snapshot?.signatureEvidenceAttemptCount).toBe(0);

    const enq = await enqueueFailedPreBroadcastRetry(pool, {
      withdrawalId,
      reason: 'test-clean-attempt-1-retry',
    });
    expect(enq.accepted).toBe(true);
    expect(enq.created).toBe(true);
    expect(enq.retryOrdinal).toBe(1);

    const starter = recordingStarter();
    const batch = await processWithdrawalFailedPreRetryOutboxBatch(pool, {
      client: starter,
      taskQueue: 'test-failed-pre-attempt2',
      fakeChainEnabled: false,
      realChainEnabled: true,
    });
    expect(batch).toMatchObject({ claimed: 1, dispatched: 1, deadLetter: 0 });
    expect(starter.starts).toHaveLength(1);

    const wdCount = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(wdCount.rows[0]?.c).toBe(1);
  });

  it('prior signature evidence refuses reuse', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9911');
    await forceFailedPreZeroAttempts(withdrawalId);
    const attemptId = await insertCleanFailedPreAttempt(withdrawalId, 1);
    await pool.query(
      `UPDATE withdrawal_attempts
       SET signed_external_message_boc = 'dGVzdA==',
           signed_wallet_request_boc = 'dGVzdA==',
           external_message_cell_hash = $2,
           normalized_external_message_hash = $2
       WHERE id = $1::uuid`,
      [attemptId, 'cc'.repeat(32)],
    );

    const evalNow = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalNow.ok).toBe(false);
    expect(evalNow.refusalReasons.some((r) => r.startsWith('signature_evidence_present'))).toBe(
      true,
    );
    const enq = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    expect(enq.accepted).toBe(false);
  });

  it('prior broadcast evidence refuses reuse', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9912');
    await forceFailedPreZeroAttempts(withdrawalId);
    const attemptId = await insertCleanFailedPreAttempt(withdrawalId, 1);
    await pool.query(
      `UPDATE withdrawal_attempts SET broadcast_submitted_at = now() WHERE id = $1::uuid`,
      [attemptId],
    );

    const evalNow = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalNow.ok).toBe(false);
    expect(evalNow.refusalReasons).toContain('broadcast_submitted_evidence_present');
  });

  it('ambiguous attempt refuses reuse', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9913');
    await forceFailedPreZeroAttempts(withdrawalId);
    await insertCleanFailedPreAttempt(withdrawalId, 1);
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init
       ) VALUES (
         $1::uuid, 2, $2::uuid, 2, 99,
         now() + interval '5 minutes', $3, $4,
         2, 'UNKNOWN', false
       )`,
      [withdrawalId, hotWalletId, 'dd'.repeat(32), ENCRYPTED_SIGNER_REF],
    );

    const evalNow = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalNow.ok).toBe(false);
    expect(
      evalNow.refusalReasons.some(
        (r) => r.startsWith('ambiguous_chain_outcome') || r.startsWith('non_failed_pre_attempts'),
      ),
    ).toBe(true);
  });

  it('reserved balance not positive refuses reuse', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9914');
    await forceFailedPreZeroAttempts(withdrawalId);
    await insertCleanFailedPreAttempt(withdrawalId, 1);
    await pool.query(
      `UPDATE ledger_account_balances lab
       SET balance_atomic = 0
       FROM ledger_accounts la
       JOIN withdrawals w ON w.user_id = la.owner_id AND w.asset_id = la.asset_id
       WHERE lab.ledger_account_id = la.id
         AND w.id = $1::uuid
         AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [withdrawalId],
    );

    const evalNow = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(evalNow.ok).toBe(false);
    expect(evalNow.refusalReasons).toContain('reserved_balance_not_positive');
  });

  it('concurrent enqueue with clean attempt: only one PENDING outbox', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9915');
    await forceFailedPreZeroAttempts(withdrawalId);
    await insertCleanFailedPreAttempt(withdrawalId, 1);

    const results = await Promise.all([
      enqueueFailedPreBroadcastRetry(pool, { withdrawalId, reason: 'concurrent-a' }),
      enqueueFailedPreBroadcastRetry(pool, { withdrawalId, reason: 'concurrent-b' }),
      enqueueFailedPreBroadcastRetry(pool, { withdrawalId, reason: 'concurrent-c' }),
    ]);
    expect(results.every((r) => r.accepted)).toBe(true);
    expect(results.filter((r) => r.created).length).toBe(1);
    const outboxIds = new Set(results.map((r) => r.outboxId));
    expect(outboxIds.size).toBe(1);

    const rows = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE event_type = $1 AND aggregate_id = $2::uuid AND status = 'PENDING'`,
      [WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT, withdrawalId],
    );
    expect(rows.rows[0]?.c).toBe(1);
  });

  it('lease still held refuses reuse', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9906');
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST', updated_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
    await withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
    });

    const enq = await enqueueFailedPreBroadcastRetry(pool, { withdrawalId });
    expect(enq.accepted).toBe(false);
    expect(enq.refusalReasons).toContain('dispatch_lease_still_held');

    await withWithdrawalTransaction(pool, async (client) => {
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: owner,
        reason: 'FAILED_PRE_BROADCAST',
      });
    });
  });
});
