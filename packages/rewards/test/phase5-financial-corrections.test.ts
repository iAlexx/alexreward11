/**
 * Phase 5 financial correction suite — mandatory coverage for Owner review gaps.
 * Destructive against PHASE5_DATABASE_URL (or PHASE5_REWARD_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bindPlanEntitlement,
  completeSimulatedRewardSource,
  createBenefitRuleVersion,
  createExposureLimitVersion,
  createMembershipBonusBudgetPeriod,
  createRewardBudgetPeriod,
  createRewardQuote,
  createSimulatedRewardSourceIdentity,
  ELIGIBLE_REWARD_BONUS_CODE,
  ensureSimulatedRewardProvider,
  expireRewardQuote,
  issueSimulatedReward,
  withLedgerTransaction,
} from '../src/index.js';
import {
  createFounderBonusFixture,
  createTestOnlyBudget,
  createTestOnlyPromotionRule,
  createTestUser,
  newSimulatedSource,
  phase5DatabaseUrl,
  resetAndMigrate,
  truncateRewardTables,
  usdtAssetId,
} from './harness.js';

async function grantStandardMembership(
  pool: Pool,
  userId: string,
  grantedAt: Date,
): Promise<{ planId: string; membershipId: string }> {
  return withLedgerTransaction(pool, async (client) => {
    const plan = await client.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
    );
    const planId = plan.rows[0]?.id;
    if (planId === undefined) throw new Error('STANDARD plan missing');
    const membership = await client.query<{ id: string }>(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, status, source, granted_at
       ) VALUES ($1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', $3::timestamptz)
       RETURNING id`,
      [userId, planId, grantedAt.toISOString()],
    );
    const membershipId = membership.rows[0]?.id;
    if (membershipId === undefined) throw new Error('STANDARD membership insert failed');
    return { planId, membershipId };
  });
}

async function bindBonusToPlan(
  pool: Pool,
  input: {
    readonly planId: string;
    readonly bonusBps: number;
    readonly ruleVersion: number;
  },
): Promise<void> {
  await withLedgerTransaction(pool, async (client) => {
    const entitlement = await client.query<{ id: string }>(
      `SELECT id FROM entitlements WHERE code = $1`,
      [ELIGIBLE_REWARD_BONUS_CODE],
    );
    const entitlementId = entitlement.rows[0]?.id;
    if (entitlementId === undefined) throw new Error('ELIGIBLE_REWARD_BONUS missing');
    const benefit = await createBenefitRuleVersion(client, {
      entitlementId,
      membershipPlanId: input.planId,
      ruleVersion: input.ruleVersion,
      valueBps: input.bonusBps,
      reason: 'test-only conflicting bonus',
      activate: true,
    });
    await bindPlanEntitlement(client, {
      membershipPlanId: input.planId,
      entitlementId,
      ruleVersionId: benefit.id,
    });
  });
}

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 financial corrections', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl, max: 12 });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateRewardTables(pool);
    userId = await createTestUser(
      pool,
      String(960_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('exhausted bonus + BASE_REWARD_ONLY => base-only PASS', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    if (founder.bonusBudgetPeriodId === null) throw new Error('expected bonus budget');
    await pool.query(
      `UPDATE membership_bonus_budget_periods
       SET budget_atomic = 1, reserved_atomic = 1, consumed_atomic = 0
       WHERE id = $1`,
      [founder.bonusBudgetPeriodId],
    );
    const source = await newSimulatedSource(pool);
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
    });
    expect(quote.baseAmountAtomic).toBe('1000');
    expect(quote.membershipBonusAmountAtomic).toBe('0');
    expect(quote.bonusReservationIds).toEqual([]);
    const bonusRows = await pool.query(
      `SELECT id FROM membership_bonus_budget_reservations WHERE reward_quote_id = $1`,
      [quote.quoteId],
    );
    expect(bonusRows.rowCount).toBe(0);
  });

  it('exhausted bonus + BLOCK_QUOTE_BEFORE_START => blocked with no orphan state', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    if (founder.bonusBudgetPeriodId === null) throw new Error('expected bonus budget');
    await pool.query(
      `UPDATE membership_bonus_budget_periods
       SET budget_atomic = 1, reserved_atomic = 1, consumed_atomic = 0
       WHERE id = $1`,
      [founder.bonusBudgetPeriodId],
    );
    const source = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BLOCK_QUOTE_BEFORE_START',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
    ).rejects.toMatchObject({ code: 'BONUS_BLOCKED' });

    const quotes = await pool.query(`SELECT id FROM reward_quotes WHERE user_id = $1`, [userId]);
    expect(quotes.rowCount).toBe(0);
    const reservations = await pool.query(
      `SELECT id FROM reward_budget_reservations
       UNION ALL
       SELECT id FROM membership_bonus_budget_reservations`,
    );
    expect(reservations.rowCount).toBe(0);
  });

  it('concurrent final bonus slot + BASE_REWARD_ONLY => one bonus, one base-only', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    if (founder.bonusBudgetPeriodId === null) throw new Error('expected bonus budget');
    // Bonus amount = 50; capacity for exactly one.
    await pool.query(
      `UPDATE membership_bonus_budget_periods SET budget_atomic = 50 WHERE id = $1`,
      [founder.bonusBudgetPeriodId],
    );
    const a = await newSimulatedSource(pool);
    const b = await newSimulatedSource(pool);
    const results = await Promise.allSettled([
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: a.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: b.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    const bonuses = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<{ membershipBonusAmountAtomic: string }>).value
        .membershipBonusAmountAtomic,
    );
    expect(bonuses.sort()).toEqual(['0', '50']);
  });

  it('concurrent final bonus slot + BLOCK => one succeeds, other blocks, no orphan', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    if (founder.bonusBudgetPeriodId === null) throw new Error('expected bonus budget');
    await pool.query(
      `UPDATE membership_bonus_budget_periods SET budget_atomic = 50 WHERE id = $1`,
      [founder.bonusBudgetPeriodId],
    );
    const a = await newSimulatedSource(pool);
    const b = await newSimulatedSource(pool);
    const results = await Promise.allSettled([
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: a.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BLOCK_QUOTE_BEFORE_START',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: b.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BLOCK_QUOTE_BEFORE_START',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'BONUS_BLOCKED' });
    const quotes = await pool.query(`SELECT id FROM reward_quotes`);
    expect(quotes.rowCount).toBe(1);
  });

  it('start before expiry protects quote; start at boundary permitted; late start rejected', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '500',
      quoteTtlSeconds: 60,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });

    const sourceA = await newSimulatedSource(pool);
    const createdAt = new Date(Date.now() - 5_000);
    const quoteA = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceA.sourceId,
      providerId,
      budgetPeriodId,
      asOf: createdAt,
      evaluateMembershipBonus: false,
    });
    await completeSimulatedRewardSource(pool, {
      quoteId: quoteA.quoteId,
      sourceId: sourceA.sourceId,
      userId,
      completedAt: new Date(createdAt.getTime() + 1_000),
    });
    const expireProtected = await expireRewardQuote(
      pool,
      quoteA.quoteId,
      new Date(createdAt.getTime() + 120_000),
    );
    expect(expireProtected.released).toBe(false);
    expect(expireProtected.status).toBe('OPEN');

    const sourceB = await newSimulatedSource(pool);
    const quoteB = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceB.sourceId,
      providerId,
      budgetPeriodId,
      asOf: createdAt,
      evaluateMembershipBonus: false,
    });
    const expiresAt = new Date(quoteB.expiresAt);
    await completeSimulatedRewardSource(pool, {
      quoteId: quoteB.quoteId,
      sourceId: sourceB.sourceId,
      userId,
      completedAt: expiresAt, // boundary: startedAt <= expires_at permitted
    });
    const startedB = await pool.query<{ source_started_at: Date }>(
      `SELECT source_started_at FROM reward_quotes WHERE id = $1`,
      [quoteB.quoteId],
    );
    expect(startedB.rows[0]?.source_started_at.getTime()).toBe(expiresAt.getTime());

    const sourceC = await newSimulatedSource(pool);
    const quoteC = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceC.sourceId,
      providerId,
      budgetPeriodId,
      asOf: createdAt,
      evaluateMembershipBonus: false,
    });
    await expect(
      completeSimulatedRewardSource(pool, {
        quoteId: quoteC.quoteId,
        sourceId: sourceC.sourceId,
        userId,
        completedAt: new Date(expiresAt.getTime() + 1),
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    const late = await pool.query<{ source_started_at: Date | null; status: string }>(
      `SELECT source_started_at, status::text AS status FROM reward_quotes WHERE id = $1`,
      [quoteC.quoteId],
    );
    expect(late.rows[0]?.source_started_at).toBeNull();
    expect(late.rows[0]?.status).toBe('OPEN');

    const released = await expireRewardQuote(
      pool,
      quoteC.quoteId,
      new Date(expiresAt.getTime() + 1_000),
    );
    expect(released.released).toBe(true);
    const baseRes = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_budget_reservations WHERE reward_quote_id = $1`,
      [quoteC.quoteId],
    );
    expect(baseRes.rows[0]?.state).toBe('RELEASED');
  });

  it('arbitrary simulated source UUID is rejected; simulator completion requires simulated provider', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '100',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: randomUUID(),
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_REGISTERED' });

    const source = await createSimulatedRewardSourceIdentity(pool);
    expect(source.providerCode).toBe('SIMULATED_REWARD_SOURCE');
    expect(source.productionMonetaryStatus).toBe('BLOCKED');
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId: source.providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });
    const providerRow = await pool.query<{ code: string; production_monetary_status: string }>(
      `SELECT p.code, p.production_monetary_status::text AS production_monetary_status
       FROM reward_quotes q
       JOIN ad_providers p ON p.id = q.provider_id
       WHERE q.id = $1`,
      [quote.quoteId],
    );
    expect(providerRow.rows[0]?.code).toBe('SIMULATED_REWARD_SOURCE');
    expect(providerRow.rows[0]?.production_monetary_status).toBe('BLOCKED');
    await expect(
      pool.query(
        `UPDATE reward_quotes SET provider_id = NULL WHERE id = $1`,
        [quote.quoteId],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('STANDARD + FOUNDER resolves Founder FINANCIAL bonus regardless of grant order', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });

    // Case A: STANDARD older, FOUNDER newer
    await grantStandardMembership(pool, userId, new Date('2026-01-01T00:00:00.000Z'));
    const founderA = await createFounderBonusFixture(pool, {
      userId,
      assetId,
      bonusBps: 500,
    });
    await pool.query(`UPDATE user_memberships SET granted_at = $2 WHERE id = $1`, [
      founderA.membershipId,
      new Date('2026-02-01T00:00:00.000Z').toISOString(),
    ]);
    const sourceA = await newSimulatedSource(pool);
    const quoteA = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceA.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      membershipBonusBudgetPeriodId: founderA.bonusBudgetPeriodId,
    });
    expect(quoteA.membershipBonusAmountAtomic).toBe('50');
    expect(quoteA.membershipId).toBe(founderA.membershipId);

    await truncateRewardTables(pool);
    userId = await createTestUser(pool, String(961_000_000_000 + Math.floor(Math.random() * 1_000_000)));
    assetId = await usdtAssetId(pool);
    const { providerId: providerB } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetB = await createTestOnlyBudget(pool, { assetId });
    const founderB = await createFounderBonusFixture(pool, {
      userId,
      assetId,
      bonusBps: 500,
    });
    await pool.query(`UPDATE user_memberships SET granted_at = $2 WHERE id = $1`, [
      founderB.membershipId,
      new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ]);
    await grantStandardMembership(pool, userId, new Date('2026-03-01T00:00:00.000Z'));
    const sourceB = await newSimulatedSource(pool);
    const quoteB = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceB.sourceId,
      providerId: providerB,
      budgetPeriodId: budgetB,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      membershipBonusBudgetPeriodId: founderB.bonusBudgetPeriodId,
    });
    expect(quoteB.membershipBonusAmountAtomic).toBe('50');
    expect(quoteB.membershipId).toBe(founderB.membershipId);
  });

  it('two conflicting FINANCIAL bonus candidates fail closed', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const standard = await grantStandardMembership(
      pool,
      userId,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    await bindBonusToPlan(pool, { planId: standard.planId, bonusBps: 300, ruleVersion: 1 });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    const source = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
    ).rejects.toMatchObject({ code: 'BONUS_RESOLUTION_CONFLICT' });
  });

  it('rejects wrong asset / window / scope budgets and enforces per-user bonus cap', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const ton = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'TON'`);
    const tonId = ton.rows[0]?.id;
    if (tonId === undefined) throw new Error('TON asset missing');
    const wrongAssetBudget = await withLedgerTransaction(pool, async (client) => {
      const period = await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId: tonId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      return period.id;
    });
    const source = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId: wrongAssetBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const expiredBudget = await withLedgerTransaction(pool, async (client) => {
      const period = await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2020-01-01T00:00:00.000Z'),
        periodEnd: new Date('2020-01-02T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      return period.id;
    });
    const source2 = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source2.sourceId,
        providerId,
        budgetPeriodId: expiredBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const futureBudget = await withLedgerTransaction(pool, async (client) => {
      const period = await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2099-01-01T00:00:00.000Z'),
        periodEnd: new Date('2099-01-02T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      return period.id;
    });
    const sourceFuture = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceFuture.sourceId,
        providerId,
        budgetPeriodId: futureBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const founder = await createFounderBonusFixture(pool, {
      userId,
      assetId,
      bonusBps: 500,
      includeBonusBudget: false,
    });
    const capped = await withLedgerTransaction(pool, async (client) => {
      const period = await createMembershipBonusBudgetPeriod(client, {
        membershipPlanId: founder.planId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '1000000',
        perUserCapAtomic: '40',
      });
      return period.id;
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source3 = await newSimulatedSource(pool);
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source3.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      membershipBonusBudgetPeriodId: capped,
    });
    // Requested bonus 50 > per-user cap 40 → base-only under BASE_REWARD_ONLY
    expect(quote.membershipBonusAmountAtomic).toBe('0');
  });

  it('reserves all applicable daily+monthly+plan bonus periods together', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, {
      userId,
      assetId,
      bonusBps: 500,
      includeBonusBudget: false,
    });
    const periods = await withLedgerTransaction(pool, async (client) => {
      const daily = await createMembershipBonusBudgetPeriod(client, {
        assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      const monthly = await createMembershipBonusBudgetPeriod(client, {
        assetId,
        granularity: 'UTC_MONTH',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      const plan = await createMembershipBonusBudgetPeriod(client, {
        membershipPlanId: founder.planId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '1000000',
      });
      return [daily.id, monthly.id, plan.id];
    });
    const source = await newSimulatedSource(pool);
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
    });
    expect(quote.membershipBonusAmountAtomic).toBe('50');
    expect(quote.bonusReservationIds.length).toBeGreaterThanOrEqual(3);
    expect(quote.appliedEconomics.bonusBudgetPeriodIds.sort()).toEqual(periods.sort());
  });

  it('concurrent final exposure slots authorize at most one quote', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_GLOBAL_DAILY_REWARD_EXPENSE',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitAtomic: '1000',
        assetId,
        activate: true,
        reason: 'test-only global daily',
      });
    });
    const a = await newSimulatedSource(pool);
    const b = await newSimulatedSource(pool);
    const results = await Promise.allSettled([
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: a.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: b.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('successful quote freezes evaluated guardrail versions including ALLOW', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '100',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    let limitId = '';
    await withLedgerTransaction(pool, async (client) => {
      const limit = await createExposureLimitVersion(client, {
        limitCode: 'MAX_GLOBAL_DAILY_REWARD_EXPENSE',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitAtomic: '1000000',
        assetId,
        activate: true,
        reason: 'test-only freeze evidence',
      });
      limitId = limit.id;
    });
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
    expect(quote.appliedEconomics.exposureLimitVersionIds).toContain(limitId);
    expect(quote.appliedEconomics.evaluatedExposureLimits.length).toBeGreaterThan(0);
    expect(
      quote.appliedEconomics.evaluatedExposureLimits.some(
        (e) => e.id === limitId && e.decision === 'ALLOW',
      ),
    ).toBe(true);
  });

  it('direct UPDATE of frozen quote money/snapshot is rejected; source_started_at once', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '250',
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
    await expect(
      pool.query(`UPDATE reward_quotes SET amount_atomic = 1 WHERE id = $1`, [quote.quoteId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`UPDATE reward_quotes SET base_amount_atomic = 1 WHERE id = $1`, [quote.quoteId]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      pool.query(`UPDATE reward_quotes SET applied_economics = '{}'::jsonb WHERE id = $1`, [
        quote.quoteId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });

    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
      completedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    await expect(
      pool.query(
        `UPDATE reward_quotes SET source_started_at = $2::timestamptz WHERE id = $1`,
        [quote.quoteId, new Date('2026-06-02T00:00:00.000Z').toISOString()],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('membership bonus exposure includes candidate bonus under concurrency', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MEMBERSHIP_BONUS_DAILY',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitAtomic: '50',
        assetId,
        activate: true,
        reason: 'test-only membership daily',
      });
    });
    const a = await newSimulatedSource(pool);
    const b = await newSimulatedSource(pool);
    const results = await Promise.allSettled([
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: a.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: b.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
        membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
      }),
    ]);
    const withBonus = results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        (r as PromiseFulfilledResult<{ membershipBonusAmountAtomic: string }>).value
          .membershipBonusAmountAtomic === '50',
    );
    expect(withBonus.length).toBeLessThanOrEqual(1);
  });
});
