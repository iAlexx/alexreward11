import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  expireRewardQuote,
} from '../src/index.js';
import {
  createTestOnlyBudget,
  createTestOnlyPromotionRule,
  createTestUser,
  newSimulatedSource,
  phase5DatabaseUrl,
  resetAndMigrate,
  truncateRewardTables,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 quotes and budgets', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateRewardTables(pool);
    userId = await createTestUser(
      pool,
      String(920_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('creates a quote reserving base_amount_atomic only and freezes applied_economics', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1500',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });

    expect(quote.baseAmountAtomic).toBe('1500');
    expect(quote.membershipBonusAmountAtomic).toBe('0');
    expect(quote.amountAtomic).toBe('1500');
    expect(quote.appliedEconomics.baseAmountAtomic).toBe('1500');
    expect(quote.appliedEconomics.ruleCode).toContain('test-only-promo');
    expect(quote.appliedEconomics.sourceId).toBe(source.sourceId);

    const period = await pool.query<{ reserved_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('1500');

    const reservation = await pool.query<{ amount_atomic: string }>(
      `SELECT amount_atomic::text AS amount_atomic FROM reward_budget_reservations WHERE reward_quote_id = $1`,
      [quote.quoteId],
    );
    expect(reservation.rows[0]?.amount_atomic).toBe('1500');
  });

  it('releases reservation on expiry before start and is idempotent', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '800',
      quoteTtlSeconds: 1,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);
    const createdAt = new Date(Date.now() - 3_000);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      asOf: createdAt,
      evaluateMembershipBonus: false,
    });

    const expired = await expireRewardQuote(pool, quote.quoteId, new Date());
    expect(expired.status).toBe('EXPIRED');
    expect(expired.released).toBe(true);

    const period = await pool.query<{ reserved_atomic: string; released_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic, released_atomic::text AS released_atomic
       FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('0');
    expect(period.rows[0]?.released_atomic).toBe('800');

    const again = await expireRewardQuote(pool, quote.quoteId, new Date());
    expect(again.released).toBe(false);
    expect(again.status).toBe('EXPIRED');
  });

  it('does not release reservation after source_started_at', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '700',
      quoteTtlSeconds: 1,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);
    const createdAt = new Date(Date.now() - 3_000);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      asOf: createdAt,
      evaluateMembershipBonus: false,
    });

    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
      completedAt: new Date(createdAt.getTime() + 500),
    });

    const result = await expireRewardQuote(pool, quote.quoteId, new Date());
    expect(result.released).toBe(false);
    expect(result.status).toBe('OPEN');

    const period = await pool.query<{ reserved_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('700');
  });

  it('fails closed when budget is exhausted', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '5000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      budgetAtomic: '1000',
    });
    const source = await newSimulatedSource(pool);

    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });
});
