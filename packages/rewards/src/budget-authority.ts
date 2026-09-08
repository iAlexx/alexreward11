import type { PoolClient } from 'pg';

import { RewardDomainError } from './errors.js';

export interface ValidatedBaseBudgetPeriod {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeReferenceId: string | null;
  readonly countryGroup: string | null;
  readonly assetId: string;
  readonly granularity: string;
  readonly ruleVersion: number | null;
  readonly budgetAtomic: string;
  readonly reservedAtomic: string;
  readonly consumedAtomic: string;
}

export interface ApplicableBonusBudgetPeriod {
  readonly id: string;
  readonly membershipPlanId: string | null;
  readonly userId: string | null;
  readonly assetId: string;
  readonly granularity: string;
  readonly budgetAtomic: string;
  readonly reservedAtomic: string;
  readonly consumedAtomic: string;
  readonly perUserCapAtomic: string | null;
}

/**
 * Validate a caller-provided base budget period id as a locator only.
 * Authority comes from ACTIVE status, asset, window, scope, and optional provider/country/rule.
 */
export async function validateBaseBudgetPeriod(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly assetId: string;
    readonly asOf: Date;
    readonly providerId?: string | null;
    readonly countryGroup?: string | null;
    readonly ruleVersion?: number | null;
  },
): Promise<ValidatedBaseBudgetPeriod> {
  const result = await client.query<{
    id: string;
    scope_type: string;
    scope_reference_id: string | null;
    country_group: string | null;
    asset_id: string;
    granularity: string;
    rule_version: number | null;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    status: string;
    period_start: Date;
    period_end: Date;
  }>(
    `SELECT id, scope_type::text AS scope_type, scope_reference_id, country_group, asset_id,
            granularity::text AS granularity, rule_version,
            budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
            consumed_atomic::text AS consumed_atomic, status,
            period_start, period_end
     FROM reward_budget_periods
     WHERE id = $1
     FOR UPDATE`,
    [input.budgetPeriodId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'reward budget period not found', {
      details: { budgetPeriodId: input.budgetPeriodId },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new RewardDomainError('BUDGET_EXHAUSTED', 'reward budget period is not ACTIVE', {
      details: { budgetPeriodId: input.budgetPeriodId, status: row.status },
    });
  }
  if (row.asset_id !== input.assetId) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'budget period asset does not match quote',
      {
        details: { budgetPeriodId: input.budgetPeriodId, expectedAssetId: input.assetId },
      },
    );
  }
  const asOfMs = input.asOf.getTime();
  if (asOfMs < row.period_start.getTime() || asOfMs >= row.period_end.getTime()) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'budget period is outside the quote asOf window',
      {
        details: {
          budgetPeriodId: input.budgetPeriodId,
          periodStart: row.period_start.toISOString(),
          periodEnd: row.period_end.toISOString(),
          asOf: input.asOf.toISOString(),
        },
      },
    );
  }
  if (
    row.scope_type === 'PROVIDER' &&
    input.providerId !== undefined &&
    input.providerId !== null &&
    row.scope_reference_id !== null &&
    row.scope_reference_id !== input.providerId
  ) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'budget period provider scope does not match quote',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  if (
    row.country_group !== null &&
    input.countryGroup !== undefined &&
    input.countryGroup !== null &&
    row.country_group !== input.countryGroup
  ) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'budget period country scope does not match quote',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  if (
    row.rule_version !== null &&
    input.ruleVersion !== undefined &&
    input.ruleVersion !== null &&
    row.rule_version !== input.ruleVersion
  ) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'budget period rule_version does not match quote rule',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }

  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeReferenceId: row.scope_reference_id,
    countryGroup: row.country_group,
    assetId: row.asset_id,
    granularity: row.granularity,
    ruleVersion: row.rule_version,
    budgetAtomic: row.budget_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
  };
}

/**
 * Server-resolve all applicable membership bonus budget periods for a quote context.
 * Optional locator IDs must validate as members of the resolved set (or exact authority match).
 */
export async function resolveApplicableBonusBudgetPeriods(
  client: PoolClient,
  input: {
    readonly assetId: string;
    readonly asOf: Date;
    readonly userId: string;
    readonly membershipPlanId: string;
    readonly locatorPeriodIds?: readonly string[];
  },
): Promise<ApplicableBonusBudgetPeriod[]> {
  const result = await client.query<{
    id: string;
    membership_plan_id: string | null;
    user_id: string | null;
    asset_id: string;
    granularity: string;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    per_user_cap_atomic: string | null;
    status: string;
    period_start: Date;
    period_end: Date;
  }>(
    `SELECT id, membership_plan_id, user_id, asset_id, granularity::text AS granularity,
            budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
            consumed_atomic::text AS consumed_atomic,
            per_user_cap_atomic::text AS per_user_cap_atomic, status,
            period_start, period_end
     FROM membership_bonus_budget_periods
     WHERE asset_id = $1::uuid
       AND status = 'ACTIVE'
       AND period_start <= $2::timestamptz
       AND period_end > $2::timestamptz
       AND (
         (membership_plan_id IS NULL AND user_id IS NULL)
         OR (membership_plan_id = $3::uuid AND user_id IS NULL)
         OR (user_id = $4::uuid)
       )
     ORDER BY id ASC
     FOR UPDATE`,
    [input.assetId, input.asOf.toISOString(), input.membershipPlanId, input.userId],
  );

  const applicable = result.rows.map((row) => ({
    id: row.id,
    membershipPlanId: row.membership_plan_id,
    userId: row.user_id,
    assetId: row.asset_id,
    granularity: row.granularity,
    budgetAtomic: row.budget_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
    perUserCapAtomic: row.per_user_cap_atomic,
  }));

  if (input.locatorPeriodIds !== undefined && input.locatorPeriodIds.length > 0) {
    const applicableIds = new Set(applicable.map((p) => p.id));
    for (const locatorId of input.locatorPeriodIds) {
      if (!applicableIds.has(locatorId)) {
        // Validate the locator itself to surface precise mismatch reasons.
        await validateBonusBudgetPeriodLocator(client, {
          budgetPeriodId: locatorId,
          assetId: input.assetId,
          asOf: input.asOf,
          userId: input.userId,
          membershipPlanId: input.membershipPlanId,
        });
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'membership bonus budget locator is not applicable to this quote',
          { details: { budgetPeriodId: locatorId } },
        );
      }
    }
  }

  return applicable;
}

export async function validateBonusBudgetPeriodLocator(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly assetId: string;
    readonly asOf: Date;
    readonly userId: string;
    readonly membershipPlanId: string;
  },
): Promise<ApplicableBonusBudgetPeriod> {
  const result = await client.query<{
    id: string;
    membership_plan_id: string | null;
    user_id: string | null;
    asset_id: string;
    granularity: string;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    per_user_cap_atomic: string | null;
    status: string;
    period_start: Date;
    period_end: Date;
  }>(
    `SELECT id, membership_plan_id, user_id, asset_id, granularity::text AS granularity,
            budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
            consumed_atomic::text AS consumed_atomic,
            per_user_cap_atomic::text AS per_user_cap_atomic, status,
            period_start, period_end
     FROM membership_bonus_budget_periods
     WHERE id = $1
     FOR UPDATE`,
    [input.budgetPeriodId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'membership bonus budget period not found', {
      details: { budgetPeriodId: input.budgetPeriodId },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new RewardDomainError(
      'BUDGET_EXHAUSTED',
      'membership bonus budget period is not ACTIVE',
      {
        details: { budgetPeriodId: input.budgetPeriodId, status: row.status },
      },
    );
  }
  if (row.asset_id !== input.assetId) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'membership bonus budget asset does not match quote',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  const asOfMs = input.asOf.getTime();
  if (asOfMs < row.period_start.getTime() || asOfMs >= row.period_end.getTime()) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'membership bonus budget period is outside the quote asOf window',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  if (row.membership_plan_id !== null && row.membership_plan_id !== input.membershipPlanId) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'membership bonus budget plan scope does not match',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  if (row.user_id !== null && row.user_id !== input.userId) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'membership bonus budget user scope does not match',
      { details: { budgetPeriodId: input.budgetPeriodId } },
    );
  }
  return {
    id: row.id,
    membershipPlanId: row.membership_plan_id,
    userId: row.user_id,
    assetId: row.asset_id,
    granularity: row.granularity,
    budgetAtomic: row.budget_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
    perUserCapAtomic: row.per_user_cap_atomic,
  };
}

/**
 * Enforce per_user_cap_atomic for a bonus period against this user_membership usage.
 */
export async function assertPerUserBonusCap(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly userMembershipId: string;
    readonly perUserCapAtomic: string;
    readonly amountAtomic: bigint;
  },
): Promise<void> {
  const used = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_atomic), 0)::text AS total
     FROM membership_bonus_budget_reservations
     WHERE budget_period_id = $1::uuid
       AND user_membership_id = $2::uuid
       AND state IN ('ACTIVE', 'CONSUMED')`,
    [input.budgetPeriodId, input.userMembershipId],
  );
  const current = BigInt(used.rows[0]?.total ?? '0');
  const cap = BigInt(input.perUserCapAtomic);
  if (current + input.amountAtomic > cap) {
    throw new RewardDomainError('BUDGET_EXHAUSTED', 'membership bonus per-user cap exhausted', {
      details: {
        budgetPeriodId: input.budgetPeriodId,
        perUserCapAtomic: input.perUserCapAtomic,
        usedAtomic: current.toString(10),
        requested: input.amountAtomic.toString(10),
      },
    });
  }
}
