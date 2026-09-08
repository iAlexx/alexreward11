/**
 * Shared Phase 5 reward-engine test helpers.
 * Destructive against PHASE5_DATABASE_URL (or PHASE5_REWARD_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { migrateDatabase } from '@alex-rewards/db';
import { Client, type Pool } from 'pg';

import {
  bindPlanEntitlement,
  createBenefitRuleVersion,
  createMembershipBonusBudgetPeriod,
  createRewardBudgetPeriod,
  createRewardRuleVersion,
  createSimulatedRewardSourceIdentity,
  ensureSimulatedRewardProvider,
  ELIGIBLE_REWARD_BONUS_CODE,
  withLedgerTransaction,
} from '../src/index.js';

const explicitUrl = process.env.PHASE5_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE5_REWARD_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase5DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export async function resetAndMigrate(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

export async function createTestUser(pool: Pool, telegramUserId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('USDT asset missing');
  return id;
}

export async function truncateRewardTables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      outbox_events,
      reward_maturities,
      economic_exposure_reservations,
      economic_exposure_periods,
      membership_bonus_budget_reservations,
      reward_budget_reservations,
      reward_events,
      reward_quotes,
      simulated_reward_sources,
      membership_bonus_budget_periods,
      reward_budget_periods,
      membership_plan_entitlements,
      membership_benefit_rule_versions,
      user_memberships,
      membership_grant_events,
      membership_claim_codes,
      economic_exposure_limits,
      reward_rules,
      ledger_entries,
      ledger_account_balances,
      ledger_transactions,
      ledger_accounts,
      ad_providers,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function createTestOnlyPromotionRule(
  pool: Pool,
  input: {
    readonly assetId: string;
    readonly code?: string;
    readonly fixedRewardAtomic?: string;
    readonly pendingHoldSeconds?: number;
    readonly quoteTtlSeconds?: number;
    readonly providerId?: string | null;
  },
): Promise<{ ruleId: string; code: string; providerId: string }> {
  return withLedgerTransaction(pool, async (client) => {
    const provider =
      input.providerId !== undefined && input.providerId !== null
        ? { id: input.providerId }
        : await ensureSimulatedRewardProvider(client);
    const code = input.code ?? `test-only-promo-${randomUUID().slice(0, 8)}`;
    const rule = await createRewardRuleVersion(client, {
      code,
      sourceType: 'PROMOTION',
      assetId: input.assetId,
      providerId: provider.id,
      fixedRewardAtomic: input.fixedRewardAtomic ?? '1000',
      pendingHoldSeconds: input.pendingHoldSeconds ?? 0,
      quoteTtlSeconds: input.quoteTtlSeconds ?? 600,
      validFrom: new Date(Date.now() - 86_400_000),
      reason: 'test-only Phase 5 rule',
      activate: true,
    });
    return { ruleId: rule.id, code, providerId: provider.id };
  });
}

export async function createTestOnlyBudget(
  pool: Pool,
  input: { readonly assetId: string; readonly budgetAtomic?: string },
): Promise<string> {
  return withLedgerTransaction(pool, async (client) => {
    const period = await createRewardBudgetPeriod(client, {
      scopeType: 'GLOBAL',
      assetId: input.assetId,
      granularity: 'UTC_DAY',
      periodStart: new Date('2026-01-01T00:00:00.000Z'),
      periodEnd: new Date('2027-01-01T00:00:00.000Z'),
      budgetAtomic: input.budgetAtomic ?? '100000000',
    });
    return period.id;
  });
}

export async function createFounderBonusFixture(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly assetId: string;
    readonly bonusBps?: number;
    /** When false, no membership_bonus_budget_periods row is created. Default true. */
    readonly includeBonusBudget?: boolean;
  },
): Promise<{
  membershipId: string;
  planId: string;
  entitlementId: string;
  benefitRuleVersionId: string;
  bonusBudgetPeriodId: string | null;
}> {
  return withLedgerTransaction(pool, async (client) => {
    const plan = await client.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
    );
    const planId = plan.rows[0]?.id;
    if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');

    const entitlement = await client.query<{ id: string }>(
      `SELECT id FROM entitlements WHERE code = $1`,
      [ELIGIBLE_REWARD_BONUS_CODE],
    );
    const entitlementId = entitlement.rows[0]?.id;
    if (entitlementId === undefined) throw new Error('ELIGIBLE_REWARD_BONUS missing');

    const benefit = await createBenefitRuleVersion(client, {
      entitlementId,
      membershipPlanId: planId,
      ruleVersion: 1,
      valueBps: input.bonusBps ?? 500,
      reason: 'test-only Founder bonus 500 bps',
      activate: true,
    });

    await bindPlanEntitlement(client, {
      membershipPlanId: planId,
      entitlementId,
      ruleVersionId: benefit.id,
    });

    const membership = await client.query<{ id: string }>(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, founder_number, status, source, granted_at
       ) VALUES (
         $1::uuid, $2::uuid, nextval('founder_number_seq'), 'ACTIVE', 'OWNER_GRANT', now()
       )
       RETURNING id`,
      [input.userId, planId],
    );
    const membershipId = membership.rows[0]?.id;
    if (membershipId === undefined) throw new Error('membership insert failed');

    let bonusBudgetPeriodId: string | null = null;
    if (input.includeBonusBudget !== false) {
      const bonusBudget = await createMembershipBonusBudgetPeriod(client, {
        membershipPlanId: planId,
        assetId: input.assetId,
        granularity: 'UTC_DAY',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2027-01-01T00:00:00.000Z'),
        budgetAtomic: '100000000',
      });
      bonusBudgetPeriodId = bonusBudget.id;
    }

    return {
      membershipId,
      planId,
      entitlementId,
      benefitRuleVersionId: benefit.id,
      bonusBudgetPeriodId,
    };
  });
}

export async function newSimulatedSource(pool: Pool): Promise<{
  sourceId: string;
  providerId: string;
}> {
  const identity = await createSimulatedRewardSourceIdentity(pool);
  return { sourceId: identity.sourceId, providerId: identity.providerId };
}
