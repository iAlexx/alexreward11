import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  withWithdrawalTransaction,
  WithdrawalDomainError,
} from '../src/index.js';
import {
  assertLedgerBalanced,
  bindVerifiedPrimaryWallet,
  claimFounderForUser,
  createTestUser,
  engineConfig,
  fundUserAvailable,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedFounderFeeDiscount,
  seedFounderPriorityReview,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 reservation concurrency', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 40 });
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

  it('moves Available → Reserved exact gross on create', async () => {
    const userId = await createTestUser(pool, '7101');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '1000000',
      key: randomUUID(),
    });

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const withdrawal = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });

    expect(withdrawal.state).toBe('MANUAL_REVIEW');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      800000n,
    );
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('insufficient available is rejected without reservation', async () => {
    const userId = await createTestUser(pool, '7102');
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
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE' });
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
  });

  it('same idempotency key posts reservation once', async () => {
    const userId = await createTestUser(pool, '7103');
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
    const key = randomUUID();
    const a = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: key,
    });
    const b = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('same quote concurrent different keys → at most one reservation', async () => {
    const userId = await createTestUser(pool, '7104');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '1000000',
      key: randomUUID(),
    });
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          quoteId: quote.id,
          idempotencyKey: `same-quote-${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(200000n);
  });

  it('100 concurrent creates vs Available=1000000: Reserved<=fund, Available never negative, ledger balanced', async () => {
    const userId = await createTestUser(pool, '7105');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '1000000',
      key: randomUUID(),
    });

    const quotes = [];
    for (let i = 0; i < 100; i += 1) {
      quotes.push(
        await createWithdrawalQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          amountAtomic: '200000',
        }),
      );
    }

    const results = await Promise.allSettled(
      quotes.map((q, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          quoteId: q.id,
          idempotencyKey: `concurrent-${i}`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // 1000000 / 200000 = 5 successes max (balance binds before hourly 5e6)
    expect(fulfilled.length).toBe(5);
    expect(rejected.length).toBe(95);
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(WithdrawalDomainError);
        expect((r.reason as WithdrawalDomainError).code).toMatch(
          /INSUFFICIENT_AVAILABLE|LIMIT_EXCEEDED/,
        );
      }
    }

    const available = await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY');
    const reserved = await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY');
    expect(available).toBe(0n);
    expect(available >= 0n).toBe(true);
    expect(reserved).toBe(1000000n);
    expect(reserved <= 1000000n).toBe(true);
    await assertLedgerBalanced(pool);
  });

  it('user hourly final-slot race with real PG', async () => {
    const userId = await createTestUser(pool, '7106');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '20000000',
      key: randomUUID(),
    });

    const quotes = [];
    for (let i = 0; i < 4; i += 1) {
      quotes.push(
        await createWithdrawalQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          amountAtomic: '5000000',
        }),
      );
    }

    const results = await Promise.allSettled(
      quotes.map((q, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          quoteId: q.id,
          idempotencyKey: `vol-hour-${i}`,
        }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(3);
    for (const r of fail) {
      if (r.status === 'rejected') {
        expect((r.reason as WithdrawalDomainError).code).toBe('LIMIT_EXCEEDED');
      }
    }
  });

  it('user daily final-slot race with real PG', async () => {
    const userId = await createTestUser(pool, '7107');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    // Lower hourly so daily (10e6) is the binding cap after two hourly windows are impractical;
    // instead seed a custom limit rule: hourly 50e6, daily 10e6, then race 3×5e6.
    await pool.query(
      `UPDATE withdrawal_limit_rules
       SET status = 'SUPERSEDED', valid_to = now(), updated_at = now()
       WHERE status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO withdrawal_limit_rules (
         asset_id, network_id, rule_version, risk_tier,
         min_withdrawal_atomic, max_single_withdrawal_atomic,
         max_user_hourly_atomic, max_user_daily_atomic,
         max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
         max_auto_payout_atomic, wallet_change_cooldown_seconds,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 2, NULL,
         200000, 5000000,
         50000000, 10000000,
         25000000, 100000000,
         NULL, 86400,
         'ACTIVE', now(), 'PHASE7 daily race'
       )`,
      [assetId, networkId],
    );

    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '20000000',
      key: randomUUID(),
    });

    const quotes = [];
    for (let i = 0; i < 3; i += 1) {
      quotes.push(
        await createWithdrawalQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          amountAtomic: '5000000',
        }),
      );
    }

    const results = await Promise.allSettled(
      quotes.map((q, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          quoteId: q.id,
          idempotencyKey: `vol-day-${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(2);
    const fail = results.filter((r) => r.status === 'rejected');
    expect(fail.length).toBe(1);
    if (fail[0]?.status === 'rejected') {
      expect((fail[0].reason as WithdrawalDomainError).code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('hot wallet hourly final-slot race with real PG', async () => {
    // Custom hot hourly = 5e6 so two users at 5e6 compete for hot hourly.
    await pool.query(
      `UPDATE withdrawal_limit_rules
       SET status = 'SUPERSEDED', valid_to = now(), updated_at = now()
       WHERE status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO withdrawal_limit_rules (
         asset_id, network_id, rule_version, risk_tier,
         min_withdrawal_atomic, max_single_withdrawal_atomic,
         max_user_hourly_atomic, max_user_daily_atomic,
         max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
         max_auto_payout_atomic, wallet_change_cooldown_seconds,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 2, NULL,
         200000, 5000000,
         50000000, 100000000,
         5000000, 100000000,
         NULL, 86400,
         'ACTIVE', now(), 'PHASE7 hot hourly race'
       )`,
      [assetId, networkId],
    );

    const users = [];
    for (let i = 0; i < 3; i += 1) {
      const userId = await createTestUser(pool, `7110${i}`);
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      await fundUserAvailable({
        pool,
        userId,
        assetId,
        amountAtomic: '5000000',
        key: randomUUID(),
      });
      const quote = await createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '5000000',
      });
      users.push({ userId, quoteId: quote.id });
    }

    const results = await Promise.allSettled(
      users.map((u, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: u.userId,
          quoteId: u.quoteId,
          idempotencyKey: `hot-hour-${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(2);
  });

  it('hot wallet daily final-slot race with real PG', async () => {
    await pool.query(
      `UPDATE withdrawal_limit_rules
       SET status = 'SUPERSEDED', valid_to = now(), updated_at = now()
       WHERE status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO withdrawal_limit_rules (
         asset_id, network_id, rule_version, risk_tier,
         min_withdrawal_atomic, max_single_withdrawal_atomic,
         max_user_hourly_atomic, max_user_daily_atomic,
         max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
         max_auto_payout_atomic, wallet_change_cooldown_seconds,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 2, NULL,
         200000, 5000000,
         50000000, 100000000,
         50000000, 10000000,
         NULL, 86400,
         'ACTIVE', now(), 'PHASE7 hot daily race'
       )`,
      [assetId, networkId],
    );

    const users = [];
    for (let i = 0; i < 3; i += 1) {
      const userId = await createTestUser(pool, `7120${i}`);
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      await fundUserAvailable({
        pool,
        userId,
        assetId,
        amountAtomic: '5000000',
        key: randomUUID(),
      });
      const quote = await createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '5000000',
      });
      users.push({ userId, quoteId: quote.id });
    }

    const results = await Promise.allSettled(
      users.map((u, i) =>
        createWithdrawalFromQuote(pool, engineConfig, {
          authenticatedUserId: u.userId,
          quoteId: u.quoteId,
          idempotencyKey: `hot-day-${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1);
  });

  it('Founder priority/fee discount does not bypass volume limits', async () => {
    const userId = await createTestUser(pool, '7108');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await withWithdrawalTransaction(pool, async (client) => {
      await seedFounderPriorityReview(client);
      await seedFounderFeeDiscount(client, { discountBps: 10_000, assetId });
    });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '20000000',
      key: randomUUID(),
    });

    const firstQuote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '5000000',
    });
    expect(firstQuote.priorityReview).toBe(true);
    expect(firstQuote.feeAmountAtomic).toBe('0');
    await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: firstQuote.id,
      idempotencyKey: randomUUID(),
    });

    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '5000000',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('volume is not released when later rejected (committed request volume permanent)', async () => {
    const userId = await createTestUser(pool, '7109');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '10000000',
      key: randomUUID(),
    });

    const first = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '5000000',
    });
    const w = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: first.id,
      idempotencyKey: randomUUID(),
    });

    const before = await pool.query<{ consumed_atomic: string }>(
      `SELECT consumed_atomic::text FROM withdrawal_volume_periods
       WHERE user_id = $1::uuid AND scope = 'USER_HOURLY'`,
      [userId],
    );
    expect(BigInt(before.rows[0]?.consumed_atomic ?? '0')).toBe(5_000_000n);

    await decideWithdrawal(pool, engineConfig, {
      withdrawalId: w.id,
      expectedState: 'MANUAL_REVIEW',
      decision: 'REJECT',
      trustedOwnerActorContext: { adminUserId },
      reason: 'reject-keep-volume',
      idempotencyKey: randomUUID(),
    });

    const after = await pool.query<{ consumed_atomic: string }>(
      `SELECT consumed_atomic::text FROM withdrawal_volume_periods
       WHERE user_id = $1::uuid AND scope = 'USER_HOURLY'`,
      [userId],
    );
    expect(BigInt(after.rows[0]?.consumed_atomic ?? '0')).toBe(5_000_000n);

    // Funds returned to Available, but hourly volume still consumed —
    // quote-time headroom check must fail closed (no silent re-authorization).
    expect(await userBucketBalance(pool, userId, assetId, 'USER_AVAILABLE_LIABILITY')).toBe(
      10000000n,
    );
    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '5000000',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
