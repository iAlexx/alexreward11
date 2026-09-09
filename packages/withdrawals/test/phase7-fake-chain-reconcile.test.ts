import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError } from '../src/index.js';
import {
  FakePayoutChain,
  advanceFakeReconciliation,
  createWithdrawalAttempt,
  acquireTestDispatchLease,
  decideWithdrawal,
  localWithdrawalEngineFixtureConfig,
  matchIntendedPayout,
  reconcileWithdrawalAttempt,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  approveWithdrawal,
  bindVerifiedPrimaryWallet,
  createTestUser,
  engineConfig,
  fundHotWalletUsdt,
  fundUserAvailable,
  phase7DatabaseUrl,
  platformAccountBalance,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

async function createApprovedWithdrawal(
  pool: Pool,
  input: {
    userId: string;
    networkId: string;
    assetId: string;
    adminUserId: string;
    hotWalletId: string;
    amountAtomic: string;
  },
): Promise<string> {
  await fundUserAvailable({
    pool,
    userId: input.userId,
    assetId: input.assetId,
    amountAtomic: '5000000',
    key: randomUUID(),
  });
  await fundHotWalletUsdt(pool, input.hotWalletId, '10000000');
  const { withdrawalId } = await quoteAndCreate(
    pool,
    input.userId,
    input.amountAtomic,
    randomUUID(),
  );
  await approveWithdrawal(pool, input.adminUserId, withdrawalId);
  return withdrawalId;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 fake chain reconcile', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

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
    hotWalletId = base.hotWalletId;
  });

  it('CONFIRMED_SUCCESS path: approve → pipeline → CONFIRMED + settlement once', async () => {
    const userId = await createTestUser(pool, '7301');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    const feeBefore = await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', assetId);
    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    expect(result.state).toBe('CONFIRMED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);

    const settled = await pool.query<{ settlement_ledger_tx_id: string | null }>(
      `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(settled.rows[0]?.settlement_ledger_tx_id).not.toBeNull();

    const feeAfter = await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', assetId);
    expect(feeAfter - feeBefore).toBe(10000n);
  });

  it('DEFINITE_PRE_BROADCAST_FAILURE → FAILED_PRE_BROADCAST; retry allowed', async () => {
    const userId = await createTestUser(pool, '7302');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    const failed = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'DEFINITE_PRE_BROADCAST_FAILURE',
    );
    expect(failed.state).toBe('FAILED_PRE_BROADCAST');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);

    const retry = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'CONFIRMED_SUCCESS',
    );
    expect(retry.state).toBe('CONFIRMED');
  });

  it('CRASH_AFTER_POSSIBLE_BROADCAST / BROADCAST_RESULT_UNKNOWN → RECONCILE_REQUIRED; Reserved unchanged', async () => {
    for (const [scenario, telegramId] of [
      ['CRASH_AFTER_POSSIBLE_BROADCAST', '73131'],
      ['BROADCAST_RESULT_UNKNOWN', '73132'],
    ] as const) {
      await truncateWithdrawalTables(pool);
      const base = await seedPhase7Base(pool);
      assetId = base.assetId;
      networkId = base.networkId;
      adminUserId = base.adminUserId;
      hotWalletId = base.hotWalletId;

      const userId = await createTestUser(pool, telegramId);
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });

      const result = await runFakePayoutPipeline(pool, engineConfig, withdrawalId, scenario);
      expect(result.state).toBe('RECONCILE_REQUIRED');
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        200000n,
      );
    }
  });

  it('no new attempt while ambiguity (RECONCILE_REQUIRED)', async () => {
    const userId = await createTestUser(pool, '7304');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'BROADCAST_RESULT_UNKNOWN');
    await expect(
      runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'CONFIRMED_SUCCESS'),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    const attempts = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe('1');
  });

  it('UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION via advanceFakeReconciliation', async () => {
    const userId = await createTestUser(pool, '7305');
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
    expect(unknown.state).toBe('RECONCILE_REQUIRED');
    expect(unknown.attemptId).not.toBeNull();

    const confirmed = await advanceFakeReconciliation(pool, engineConfig, fakeChain, {
      withdrawalId,
      attemptId: unknown.attemptId!,
      scenario: 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION',
    });
    expect(confirmed.state).toBe('CONFIRMED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
  });

  it('UNKNOWN_THEN_DEFINITIVE_NONPAYMENT → HELD; reject without proof forbidden; with proof releases', async () => {
    const userId = await createTestUser(pool, '7306');
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

    const flags = await pool.query<{ held_from_reconcile: boolean }>(
      `SELECT held_from_reconcile FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(flags.rows[0]?.held_from_reconcile).toBe(true);

    await expect(
      decideWithdrawal(pool, engineConfig, {
        withdrawalId,
        expectedState: 'HELD',
        decision: 'REJECT',
        trustedOwnerActorContext: { adminUserId },
        reason: 'no-proof',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'TRANSITION_FORBIDDEN',
    } satisfies Partial<WithdrawalDomainError>);

    await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'HELD',
      decision: 'REJECT',
      trustedOwnerActorContext: { adminUserId },
      reason: 'nonpayment proven',
      idempotencyKey: randomUUID(),
      definitiveNonpayment: true,
    });

    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      5000000n,
    );
  });

  it('wrong recipient/amount/asset/query not confirmed', () => {
    const base = {
      expectedRecipient: 'EQ_RIGHT',
      expectedNetAtomic: '190000',
      expectedAssetSymbol: 'USDT',
      expectedQueryId: '42',
    };
    expect(
      matchIntendedPayout({
        ...base,
        observedRecipient: 'EQ_WRONG',
        observedAmountAtomic: '190000',
        observedAssetSymbol: 'USDT',
        observedQueryId: '42',
      }),
    ).toBe(false);
    expect(
      matchIntendedPayout({
        ...base,
        observedRecipient: 'EQ_RIGHT',
        observedAmountAtomic: '1',
        observedAssetSymbol: 'USDT',
        observedQueryId: '42',
      }),
    ).toBe(false);
    expect(
      matchIntendedPayout({
        ...base,
        observedRecipient: 'EQ_RIGHT',
        observedAmountAtomic: '190000',
        observedAssetSymbol: 'TON',
        observedQueryId: '42',
      }),
    ).toBe(false);
    expect(
      matchIntendedPayout({
        ...base,
        observedRecipient: 'EQ_RIGHT',
        observedAmountAtomic: '190000',
        observedAssetSymbol: 'USDT',
        observedQueryId: '99',
      }),
    ).toBe(false);
    expect(
      matchIntendedPayout({
        ...base,
        observedRecipient: 'EQ_RIGHT',
        observedAmountAtomic: '190000',
        observedAssetSymbol: 'USDT',
        observedQueryId: '42',
      }),
    ).toBe(true);
  });

  it('wrong observation fields stay AMBIGUOUS via reconcile API', async () => {
    const userId = await createTestUser(pool, '7307');
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

    const result = await reconcileWithdrawalAttempt(pool, engineConfig, {
      withdrawalId,
      attemptId: unknown.attemptId!,
      observedRecipient: 'EQ_WRONG_RECIPIENT',
      observedAmountAtomic: '190000',
      observedAssetSymbol: 'USDT',
      observedQueryId: '1',
      resolution: 'INTENDED_PAYOUT_PROVEN',
    });
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.state).toBe('RECONCILE_REQUIRED');
  });

  it('stale fencing token rejected', async () => {
    const userId = await createTestUser(pool, '7308');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await withWithdrawalTransaction(pool, async (client) => {
      const lease1 = await acquireTestDispatchLease(client, hotWalletId, 'worker-a');
      await acquireTestDispatchLease(client, hotWalletId, 'worker-b');
      await expect(
        createWithdrawalAttempt(client, {
          withdrawalId,
          hotWalletId,
          fencingToken: lease1.fencingToken,
          signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
          scenarioHashInputs: { scenario: 'stale' },
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });
  });

  it('fake chain fails config in STAGING/PRODUCTION', () => {
    expect(() =>
      localWithdrawalEngineFixtureConfig({
        deploymentEnvironment: 'STAGING',
        fakeChainEnabled: true,
      }),
    ).toThrow(/Fake payout chain/);
    expect(() =>
      localWithdrawalEngineFixtureConfig({
        deploymentEnvironment: 'PRODUCTION',
        fakeChainEnabled: true,
      }),
    ).toThrow(/Fake payout chain/);
  });

  it('duplicate confirmation no second settlement', async () => {
    const userId = await createTestUser(pool, '7309');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const first = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'CONFIRMED_SUCCESS',
    );
    expect(first.state).toBe('CONFIRMED');
    const settlementId = (
      await pool.query<{ settlement_ledger_tx_id: string }>(
        `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
        [withdrawalId],
      )
    ).rows[0]!.settlement_ledger_tx_id;

    await withWithdrawalTransaction(pool, async (client) => {
      const { settleWithdrawalReservation } = await import('../src/index.js');
      const again = await settleWithdrawalReservation(client, { withdrawalId });
      expect(again.settled).toBe(false);
      expect(again.ledgerTxId).toBe(settlementId);
    });

    const txCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(txCount.rows[0]?.c).toBe('1');
  });

  it('fee revenue only at CONFIRMED (not on APPROVED / RECONCILE)', async () => {
    const userId = await createTestUser(pool, '7310');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    expect(await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', assetId)).toBe(0n);

    await runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'BROADCAST_RESULT_UNKNOWN');
    expect(await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', assetId)).toBe(0n);
  });
});
