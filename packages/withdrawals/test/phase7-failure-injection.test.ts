import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError } from '../src/index.js';
import {
  FakePayoutChain,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  runFakePayoutPipeline,
} from '../src/index.js';
import {
  approveWithdrawal,
  bindVerifiedPrimaryWallet,
  createTestUser,
  engineConfig,
  fundHotWalletUsdt,
  fundUserAvailable,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 failure injection', () => {
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

  it('rolls back create when available balance is insufficient', async () => {
    const userId = await createTestUser(pool, '7401');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE',
    } satisfies Partial<WithdrawalDomainError>);

    const q = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM withdrawal_quotes WHERE id = $1::uuid`,
      [quote.id],
    );
    expect(q.rows[0]?.status).toBe('OPEN');
    const count = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawals WHERE withdrawal_quote_id = $1::uuid`,
      [quote.id],
    );
    expect(count.rows[0]?.c).toBe('0');
  });

  it('idempotency conflict does not double-reserve', async () => {
    const userId = await createTestUser(pool, '7402');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '1000000',
      key: randomUUID(),
    });
    const quoteA = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const quoteB = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '300000',
    });
    const key = randomUUID();
    await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quoteA.id,
      idempotencyKey: key,
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quoteB.id,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('duplicate outbox delivery: pipeline twice after approval → one settlement', async () => {
    const userId = await createTestUser(pool, '7403');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await fundHotWalletUsdt(pool, hotWalletId, '10000000');
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    await approveWithdrawal(pool, adminUserId, withdrawalId);

    const fakeChain = new FakePayoutChain(engineConfig);
    const first = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    expect(first.state).toBe('CONFIRMED');

    await expect(
      runFakePayoutPipeline(pool, engineConfig, fakeChain, {
        withdrawalId,
        scenario: 'CONFIRMED_SUCCESS',
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    const settlements = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(settlements.rows[0]?.c).toBe('1');
  });

  it('Temporal unavailable after approval: approval commits with outbox even if pipeline not run', async () => {
    const userId = await createTestUser(pool, '7404');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());

    const decided = await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'APPROVE',
      trustedOwnerActorContext: { adminUserId },
      reason: 'temporal-down',
      idempotencyKey: randomUUID(),
    });
    expect(decided.state).toBe('APPROVED');
    expect(decided.workflowId).toBe(`withdrawal/${withdrawalId}`);

    const outbox = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM outbox_events
       WHERE dedupe_key = $1`,
      [`withdrawal.approved:${withdrawalId}`],
    );
    expect(outbox.rows[0]?.c).toBe('1');

    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('APPROVED');
    // Pipeline deliberately not run — money still Reserved.
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('worker restart: run pipeline twice on APPROVED after first partial — safe', async () => {
    const userId = await createTestUser(pool, '7405');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await fundHotWalletUsdt(pool, hotWalletId, '10000000');
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    await approveWithdrawal(pool, adminUserId, withdrawalId);

    const partial = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'DEFINITE_PRE_BROADCAST_FAILURE',
    );
    expect(partial.state).toBe('FAILED_PRE_BROADCAST');

    const recovered = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'CONFIRMED_SUCCESS',
    );
    expect(recovered.state).toBe('CONFIRMED');

    const settlements = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(settlements.rows[0]?.c).toBe('1');
  });

  it('reserved safety: after RECONCILE_REQUIRED, Reserved == gross exactly', async () => {
    const userId = await createTestUser(pool, '7406');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await fundHotWalletUsdt(pool, hotWalletId, '10000000');
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    await approveWithdrawal(pool, adminUserId, withdrawalId);

    const result = await runFakePayoutPipeline(
      pool,
      engineConfig,
      withdrawalId,
      'CRASH_AFTER_POSSIBLE_BROADCAST',
    );
    expect(result.state).toBe('RECONCILE_REQUIRED');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      300000n,
    );
  });

  it('reject from MANUAL_REVIEW releases reservation once', async () => {
    const userId = await createTestUser(pool, '7407');
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
      reason: 'policy',
      idempotencyKey: randomUUID(),
    });

    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      500000n,
    );
  });

  it('expired quote cannot be consumed', async () => {
    const userId = await createTestUser(pool, '7408');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const shortTtl = { ...engineConfig, quoteTtlSeconds: 1 };
    const quote = await createWithdrawalQuote(pool, shortTtl, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' } satisfies Partial<WithdrawalDomainError>);

    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      500000n,
    );
  });
});
