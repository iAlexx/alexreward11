/**
 * Phase 5 narrow correction — base reward budget scope + UTC window authority.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createRewardBudgetPeriod,
  createRewardQuote,
  createRewardRuleVersion,
  ensureSimulatedRewardProvider,
  utcDayContaining,
  utcHourContaining,
  utcMonthContaining,
  withLedgerTransaction,
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

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 base budget scope authority', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl, max: 10 });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateRewardTables(pool);
    userId = await createTestUser(
      pool,
      String(970_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('GLOBAL valid succeeds; malformed GLOBAL with scope_reference_id rejected', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '100',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId, scopeType: 'GLOBAL' });
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
    expect(quote.baseAmountAtomic).toBe('100');

    const day = utcDayContaining(new Date());
    const malformed = await withLedgerTransaction(pool, async (client) => {
      const provider = await ensureSimulatedRewardProvider(client);
      // Bypass app validation via INSERT — DB allows scope shape; engine must reject.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reward_budget_periods (
           scope_type, scope_reference_id, country_group, asset_id, granularity,
           period_start, period_end, budget_atomic, status
         ) VALUES (
           'GLOBAL'::budget_scope_type, $1::uuid, NULL, $2::uuid, 'UTC_DAY'::budget_period_granularity,
           $3::timestamptz, $4::timestamptz, 1000000, 'ACTIVE'
         )
         RETURNING id`,
        [provider.id, assetId, day.periodStart.toISOString(), day.periodEnd.toISOString()],
      );
      return inserted.rows[0]!.id;
    });
    const source2 = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source2.sourceId,
        providerId,
        budgetPeriodId: malformed,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
  });

  it('PROVIDER exact match succeeds; wrong/missing provider rejected', async () => {
    const { providerId, ruleId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '200',
    });
    void ruleId;
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'PROVIDER',
      scopeReferenceId: providerId,
    });
    const source = await newSimulatedSource(pool);
    const ok = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });
    expect(ok.baseAmountAtomic).toBe('200');

    await withLedgerTransaction(pool, async (client) => {
      const { validateBaseBudgetPeriod } = await import('../src/budget-authority.js');
      await expect(
        validateBaseBudgetPeriod(client, {
          budgetPeriodId,
          assetId,
          asOf: new Date(),
          providerId: null,
          rewardRuleId: ruleId,
          ruleVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
    });

    const otherProvider = await withLedgerTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ad_providers (
           code, name, status, lifecycle_state, production_monetary_status,
           rewarded_use_allowed, incentivized_crypto_allowed, server_verification_supported
         ) VALUES (
           $1, 'Other provider', 'DISABLED', 'CONTRACTED', 'BLOCKED',
           false, false, true
         )
         RETURNING id`,
        [`OTHER_PROVIDER_${randomUUID().slice(0, 8)}`],
      );
      return inserted.rows[0]!.id;
    });
    const wrongProviderBudget = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'PROVIDER',
      scopeReferenceId: otherProvider,
    });
    const sourceWrong = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceWrong.sourceId,
        providerId,
        budgetPeriodId: wrongProviderBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
  });

  it('PROVIDER+country exact succeeds; missing/wrong country rejected', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '150',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'PROVIDER',
      scopeReferenceId: providerId,
      countryGroup: 'US',
    });
    const sourceOk = await newSimulatedSource(pool);
    const ok = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceOk.sourceId,
      providerId,
      countryGroup: 'US',
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });
    expect(ok.baseAmountAtomic).toBe('150');

    const sourceMissing = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceMissing.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const sourceWrong = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceWrong.sourceId,
        providerId,
        countryGroup: 'EU',
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
  });

  it('COUNTRY_GROUP exact succeeds; missing/wrong country rejected', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '120',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'COUNTRY_GROUP',
      countryGroup: 'US',
    });
    const sourceOk = await newSimulatedSource(pool);
    const ok = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: sourceOk.sourceId,
      providerId,
      countryGroup: 'US',
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });
    expect(ok.baseAmountAtomic).toBe('120');

    const sourceMissing = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceMissing.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const sourceWrong = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceWrong.sourceId,
        providerId,
        countryGroup: 'APAC',
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
  });

  it('REWARD_RULE exact id/version succeeds; wrong id or version rejected', async () => {
    const { providerId, ruleId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '300',
    });
    const ruleMeta = await pool.query<{ rule_version: number }>(
      `SELECT rule_version FROM reward_rules WHERE id = $1`,
      [ruleId],
    );
    const ruleVersion = ruleMeta.rows[0]!.rule_version;
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'REWARD_RULE',
      scopeReferenceId: ruleId,
      ruleVersion,
    });
    const source = await newSimulatedSource(pool);
    const ok = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });
    expect(ok.baseAmountAtomic).toBe('300');

    const otherRule = await withLedgerTransaction(pool, async (client) => {
      const provider = await ensureSimulatedRewardProvider(client);
      const rule = await createRewardRuleVersion(client, {
        code: `other-rule-${randomUUID().slice(0, 8)}`,
        sourceType: 'PROMOTION',
        assetId,
        providerId: provider.id,
        fixedRewardAtomic: '50',
        activate: true,
        validFrom: new Date(Date.now() - 86_400_000),
      });
      return rule.id;
    });
    // Two ACTIVE PROMOTION rules for same provider would make resolve ambiguous —
    // supersede the other rule before quoting against wrong budget.
    await pool.query(
      `UPDATE reward_rules SET status = 'SUPERSEDED', valid_to = now() WHERE id = $1`,
      [otherRule],
    );
    const wrongRuleBudget = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'REWARD_RULE',
      scopeReferenceId: otherRule,
      ruleVersion: 1,
    });
    const sourceWrong = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceWrong.sourceId,
        providerId,
        budgetPeriodId: wrongRuleBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const wrongVersionBudget = await createTestOnlyBudget(pool, {
      assetId,
      scopeType: 'REWARD_RULE',
      scopeReferenceId: ruleId,
      ruleVersion: ruleVersion + 99,
      granularity: 'HOUR',
    });
    const sourceVer = await newSimulatedSource(pool);
    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: sourceVer.sourceId,
        providerId,
        budgetPeriodId: wrongVersionBudget,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
  });

  it('MEMBERSHIP_PLAN / MISSION / REFERRAL cannot authorize Phase 5 base quotes', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '100',
    });
    const day = utcDayContaining(new Date());
    for (const scopeType of ['MEMBERSHIP_PLAN', 'MISSION', 'REFERRAL'] as const) {
      const budgetPeriodId = await withLedgerTransaction(pool, async (client) => {
        const period = await createRewardBudgetPeriod(client, {
          scopeType,
          assetId,
          granularity: 'UTC_DAY',
          periodStart: day.periodStart,
          periodEnd: day.periodEnd,
          budgetAtomic: '1000000',
          scopeReferenceId: randomUUID(),
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
          budgetPeriodId,
          evaluateMembershipBonus: false,
        }),
      ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });
    }
  });

  it('rejects malformed HOUR / UTC_DAY / UTC_MONTH windows; accepts canonical windows', async () => {
    await expect(
      withLedgerTransaction(pool, async (client) =>
        createRewardBudgetPeriod(client, {
          scopeType: 'GLOBAL',
          assetId,
          granularity: 'UTC_DAY',
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          periodEnd: new Date('2027-01-01T00:00:00.000Z'),
          budgetAtomic: '1000',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    await expect(
      withLedgerTransaction(pool, async (client) =>
        createRewardBudgetPeriod(client, {
          scopeType: 'GLOBAL',
          assetId,
          granularity: 'HOUR',
          periodStart: new Date('2026-06-01T12:30:00.000Z'),
          periodEnd: new Date('2026-06-01T13:30:00.000Z'),
          budgetAtomic: '1000',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    await expect(
      withLedgerTransaction(pool, async (client) =>
        createRewardBudgetPeriod(client, {
          scopeType: 'GLOBAL',
          assetId,
          granularity: 'UTC_MONTH',
          periodStart: new Date('2026-01-01T00:00:00.000Z'),
          periodEnd: new Date('2027-01-01T00:00:00.000Z'),
          budgetAtomic: '1000',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_SCOPE_MISMATCH' });

    const hour = utcHourContaining(new Date());
    const day = utcDayContaining(new Date());
    const month = utcMonthContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId,
        granularity: 'HOUR',
        periodStart: hour.periodStart,
        periodEnd: hour.periodEnd,
        budgetAtomic: '1000',
      });
      await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: '1000',
      });
      await createRewardBudgetPeriod(client, {
        scopeType: 'GLOBAL',
        assetId,
        granularity: 'UTC_MONTH',
        periodStart: month.periodStart,
        periodEnd: month.periodEnd,
        budgetAtomic: '1000',
      });
    });

    // DB CHECK rejects year-labelled UTC_DAY even via raw SQL.
    await expect(
      pool.query(
        `INSERT INTO reward_budget_periods (
           scope_type, asset_id, granularity, period_start, period_end, budget_atomic, status
         ) VALUES (
           'GLOBAL', $1::uuid, 'UTC_DAY',
           '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 1000, 'ACTIVE'
         )`,
        [assetId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
