/**
 * Phase 7 reconciliation provenance gates (Owner security correction).
 * Proves plain FakePayoutObservation objects are not financial authority.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError } from '../src/index.js';
import {
  advanceFakeReconciliation,
  decideWithdrawal,
  FakePayoutChain,
  reconcileWithdrawalAttemptFromAdapter,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  stampAuthoritativeObservationForTests,
  type AuthoritativePayoutObservation,
  type PayoutChainAdapter,
} from '../src/fake-chain.js';
import { applyObservationInTxn } from '../src/reconcile.js';
import {
  bindVerifiedPrimaryWallet,
  createApprovedWithdrawal,
  createTestUser,
  engineConfig,
  fundHotWalletUsdt,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

async function loadAttemptRow(pool: Pool, attemptId: string) {
  const result = await pool.query<{
    id: string;
    withdrawal_id: string;
    query_id: string;
    attempt_number: number;
    canonical_message_hash: string;
    net_amount_atomic: string;
    recipient: string;
  }>(
    `SELECT a.id, a.withdrawal_id, a.query_id::text, a.attempt_number, a.canonical_message_hash,
            wd.net_amount_atomic::text,
            COALESCE(w.friendly_address, w.raw_address) AS recipient
     FROM withdrawal_attempts a
     JOIN withdrawals wd ON wd.id = a.withdrawal_id
     JOIN user_wallets w ON w.id = wd.wallet_id
     WHERE a.id = $1::uuid`,
    [attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('attempt missing');
  return row;
}

function plainMatchingObservation(
  row: Awaited<ReturnType<typeof loadAttemptRow>>,
  phase: 'CONFIRMED' | 'DEFINITIVE_NONPAYMENT',
) {
  return {
    phase,
    queryId: BigInt(row.query_id),
    recipientAddress: row.recipient,
    amountAtomic: row.net_amount_atomic,
    assetSymbol: 'USDT',
    correlationReference: `fake:${row.withdrawal_id}:${row.attempt_number}`,
    mayHaveBroadcast: true,
    withdrawalId: row.withdrawal_id,
    attemptId: row.id,
    canonicalMessageHash: row.canonical_message_hash,
  };
}

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 reconcile provenance', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
    await fundHotWalletUsdt(pool, hotWalletId, '100000000');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('A: plain phase=DEFINITIVE_NONPAYMENT cannot create durable definitive evidence', async () => {
    const userId = await createTestUser(pool, '7701');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    const result = await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        observation: plainMatchingObservation(row, 'DEFINITIVE_NONPAYMENT'),
      }),
    );
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
    const durable = await pool.query<{ resolution: string; held: boolean }>(
      `SELECT r.resolution::text AS resolution, w.held_from_reconcile AS held
       FROM withdrawal_payout_reconciliations r
       JOIN withdrawals w ON w.id = r.withdrawal_id
       WHERE r.id = $1::uuid`,
      [result.reconciliationId],
    );
    expect(durable.rows[0]?.resolution).toBe('AMBIGUOUS');
    expect(durable.rows[0]?.held).toBe(false);
  });

  it('B: plain phase=CONFIRMED cannot settle merely by matching fields', async () => {
    const userId = await createTestUser(pool, '7702');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    const result = await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        observation: plainMatchingObservation(row, 'CONFIRMED'),
      }),
    );
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('C: attempt for withdrawal A cannot be reconciled using withdrawal B', async () => {
    const userA = await createTestUser(pool, '7703');
    const userB = await createTestUser(pool, '7704');
    await bindVerifiedPrimaryWallet(pool, userA, networkId);
    await bindVerifiedPrimaryWallet(pool, userB, networkId);
    const withdrawalA = await createApprovedWithdrawal(pool, {
      userId: userA,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const withdrawalB = await createApprovedWithdrawal(pool, {
      userId: userB,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const pipeA = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalA,
      'BROADCAST_RESULT_UNKNOWN',
    );
    await runFakePayoutPipeline(pool, engineConfig, withdrawalB, 'BROADCAST_RESULT_UNKNOWN');

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        applyObservationInTxn(client, engineConfig, {
          withdrawalId: withdrawalB,
          attemptId: pipeA.attemptId!,
          observation: plainMatchingObservation(
            await loadAttemptRow(pool, pipeA.attemptId!),
            'DEFINITIVE_NONPAYMENT',
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<WithdrawalDomainError>);
  });

  it('D: authoritative observation for attempt A cannot apply to attempt B', async () => {
    const userId = await createTestUser(pool, '7705');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const fakeChain = new FakePayoutChain(engineConfig);
    const first = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'BROADCAST_RESULT_UNKNOWN',
    });
    // Second attempt is blocked while RECONCILE_REQUIRED — stamp obs for attempt A, apply as B id.
    const rowA = await loadAttemptRow(pool, first.attemptId!);
    const obsA = stampAuthoritativeObservationForTests({
      ...plainMatchingObservation(rowA, 'DEFINITIVE_NONPAYMENT'),
      withdrawalId,
      attemptId: first.attemptId!,
      canonicalMessageHash: rowA.canonical_message_hash,
    });
    const fakeAttemptB = randomUUID();
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        applyObservationInTxn(client, engineConfig, {
          withdrawalId,
          attemptId: fakeAttemptB,
          observation: obsA,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('E: authoritative observation for withdrawal A cannot apply to withdrawal B', async () => {
    const userA = await createTestUser(pool, '7706');
    const userB = await createTestUser(pool, '7707');
    await bindVerifiedPrimaryWallet(pool, userA, networkId);
    await bindVerifiedPrimaryWallet(pool, userB, networkId);
    const withdrawalA = await createApprovedWithdrawal(pool, {
      userId: userA,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const withdrawalB = await createApprovedWithdrawal(pool, {
      userId: userB,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const fakeChain = new FakePayoutChain(engineConfig);
    const pipeA = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId: withdrawalA,
      scenario: 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT',
    });
    const pipeB = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId: withdrawalB,
      scenario: 'BROADCAST_RESULT_UNKNOWN',
    });
    fakeChain.advance(pipeA.attemptId!);
    const obsA = fakeChain.observeForAttempt({
      withdrawalId: withdrawalA,
      attemptId: pipeA.attemptId!,
    });
    expect(obsA?.phase).toBe('DEFINITIVE_NONPAYMENT');

    const result = await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId: withdrawalB,
        attemptId: pipeB.attemptId!,
        observation: obsA,
      }),
    );
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
  });

  it('F: wrong queryId → AMBIGUOUS', async () => {
    const userId = await createTestUser(pool, '7708');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    const obs = stampAuthoritativeObservationForTests({
      ...plainMatchingObservation(row, 'CONFIRMED'),
      queryId: BigInt(row.query_id) + 999n,
      withdrawalId,
      attemptId: unknown.attemptId!,
      canonicalMessageHash: row.canonical_message_hash,
    });
    const result = await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        observation: obs,
      }),
    );
    expect(result.resolution).toBe('AMBIGUOUS');
  });

  it('G: wrong correlation/attempt identity → AMBIGUOUS', async () => {
    const userId = await createTestUser(pool, '7709');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    const obs = stampAuthoritativeObservationForTests({
      ...plainMatchingObservation(row, 'DEFINITIVE_NONPAYMENT'),
      correlationReference: 'fake:wrong-correlation',
      withdrawalId,
      attemptId: unknown.attemptId!,
      canonicalMessageHash: row.canonical_message_hash,
    });
    const result = await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        observation: obs,
      }),
    );
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
  });

  it('H: genuine authoritative CONFIRMED for exact attempt settles once', async () => {
    const userId = await createTestUser(pool, '7710');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const fakeChain = new FakePayoutChain(engineConfig);
    const unknown = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION',
    });
    const confirmed = await advanceFakeReconciliation(pool, engineConfig, fakeChain, {
      withdrawalId,
      attemptId: unknown.attemptId!,
      scenario: 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION',
    });
    expect(confirmed.state).toBe('CONFIRMED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);

    await expect(
      reconcileWithdrawalAttemptFromAdapter(pool, engineConfig, fakeChain, {
        withdrawalId,
        attemptId: unknown.attemptId!,
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('I: genuine authoritative DEFINITIVE_NONPAYMENT → durable proof + HELD', async () => {
    const userId = await createTestUser(pool, '7711');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const fakeChain = new FakePayoutChain(engineConfig);
    const unknown = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT',
    });
    const held = await advanceFakeReconciliation(pool, engineConfig, fakeChain, {
      withdrawalId,
      attemptId: unknown.attemptId!,
      scenario: 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT',
    });
    expect(held.state).toBe('HELD');
    const evidence = await pool.query<{ resolution: string; held: boolean }>(
      `SELECT r.resolution::text AS resolution, w.held_from_reconcile AS held
       FROM withdrawal_payout_reconciliations r
       JOIN withdrawals w ON w.id = r.withdrawal_id
       WHERE w.id = $1::uuid
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [withdrawalId],
    );
    expect(evidence.rows[0]?.resolution).toBe('DEFINITIVE_NONPAYMENT');
    expect(evidence.rows[0]?.held).toBe(true);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('J: forged evidence never enables Owner REJECT release after possible broadcast', async () => {
    const userId = await createTestUser(pool, '7712');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    await withWithdrawalTransaction(pool, async (client) =>
      applyObservationInTxn(client, engineConfig, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        observation: plainMatchingObservation(row, 'DEFINITIVE_NONPAYMENT'),
      }),
    );
    // Still RECONCILE_REQUIRED — not HELD with definitive proof.
    const state = await pool.query<{ state: string; held_from_reconcile: boolean }>(
      `SELECT state::text, held_from_reconcile FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    expect(state.rows[0]?.held_from_reconcile).toBe(false);

    // Even if somehow moved to HELD without definitive proof, REJECT without proof fails.
    // Here: REJECT from RECONCILE_REQUIRED is not the release path; prove Reserved intact
    // and forged AMBIGUOUS never unlocks definitiveNonpayment REJECT.
    await expect(
      decideWithdrawal(pool, engineConfig, {
        withdrawalId,
        expectedState: 'HELD',
        decision: 'REJECT',
        trustedOwnerActorContext: { adminUserId },
        reason: 'forged-nonpayment',
        idempotencyKey: randomUUID(),
        definitiveNonpayment: true,
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('adapter observeForAttempt refuses mismatched withdrawal/attempt pair', async () => {
    const userId = await createTestUser(pool, '7713');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const fakeChain = new FakePayoutChain(engineConfig);
    const unknown = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'BROADCAST_RESULT_UNKNOWN',
    });
    expect(
      fakeChain.observeForAttempt({
        withdrawalId: randomUUID(),
        attemptId: unknown.attemptId!,
      }),
    ).toBeNull();
    await expect(
      reconcileWithdrawalAttemptFromAdapter(pool, engineConfig, fakeChain, {
        withdrawalId: randomUUID(),
        attemptId: unknown.attemptId!,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('runtime package index does not export raw observation apply', async () => {
    const runtime = await import('../src/index.js');
    expect('reconcileWithdrawalAttempt' in runtime).toBe(false);
    expect('reconcileWithdrawalAttemptInTxn' in runtime).toBe(false);
    expect('applyObservationInTxn' in runtime).toBe(false);
    expect('stampAuthoritativeObservationForTests' in runtime).toBe(false);
    expect(typeof runtime.reconcileWithdrawalAttemptFromAdapter).toBe('function');
  });

  it('stub adapter returning branded but cross-bound obs stays AMBIGUOUS', async () => {
    const userId = await createTestUser(pool, '7714');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const unknown = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'BROADCAST_RESULT_UNKNOWN',
    );
    const row = await loadAttemptRow(pool, unknown.attemptId!);
    const crossBound: AuthoritativePayoutObservation = stampAuthoritativeObservationForTests({
      ...plainMatchingObservation(row, 'DEFINITIVE_NONPAYMENT'),
      withdrawalId: randomUUID(),
      attemptId: unknown.attemptId!,
      canonicalMessageHash: row.canonical_message_hash,
    });
    const stub: PayoutChainAdapter = {
      observeForAttempt: () => crossBound,
    };
    const result = await reconcileWithdrawalAttemptFromAdapter(pool, engineConfig, stub, {
      withdrawalId,
      attemptId: unknown.attemptId!,
    });
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
  });
});
