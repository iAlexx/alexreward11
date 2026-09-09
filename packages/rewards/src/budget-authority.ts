import type { PoolClient } from 'pg';

import { RewardDomainError } from './errors.js';
import { assertCanonicalBudgetWindow, PHASE5_BASE_BUDGET_SCOPES } from './budget-windows.js';

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

function requireExactCountryMatch(
  budgetCountryGroup: string | null,
  quoteCountryGroup: string | null | undefined,
  budgetPeriodId: string,
  context: string,
): void {
  if (budgetCountryGroup === null) return;
  if (quoteCountryGroup === undefined || quoteCountryGroup === null) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      `${context} requires quote countryGroup when budget country_group is set`,
      { details: { budgetPeriodId, budgetCountryGroup } },
    );
  }
  if (quoteCountryGroup !== budgetCountryGroup) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      `${context} country_group does not match quote`,
      {
        details: {
          budgetPeriodId,
          budgetCountryGroup,
          quoteCountryGroup,
        },
      },
    );
  }
}

/**
 * Validate a caller-provided base budget period id as a locator only.
 * Authority comes from ACTIVE status, asset, canonical UTC window, and exact scope match.
 * Phase 5 base quotes may use only GLOBAL / PROVIDER / COUNTRY_GROUP / REWARD_RULE.
 */
export async function validateBaseBudgetPeriod(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly assetId: string;
    readonly asOf: Date;
    readonly providerId?: string | null;
    readonly countryGroup?: string | null;
    readonly rewardRuleId: string;
    readonly ruleVersion: number;
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

  assertCanonicalBudgetWindow(
    row.granularity,
    row.period_start,
    row.period_end,
    'reward budget period',
  );

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

  if (!PHASE5_BASE_BUDGET_SCOPES.has(row.scope_type)) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      'Phase 5 base reward quotes cannot be authorized by this budget scope_type',
      {
        details: {
          budgetPeriodId: input.budgetPeriodId,
          scopeType: row.scope_type,
          allowed: [...PHASE5_BASE_BUDGET_SCOPES],
        },
      },
    );
  }

  switch (row.scope_type) {
    case 'GLOBAL': {
      if (row.scope_reference_id !== null || row.country_group !== null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'GLOBAL base budget must have null scope_reference_id and null country_group',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              scopeReferenceId: row.scope_reference_id,
              countryGroup: row.country_group,
            },
          },
        );
      }
      break;
    }
    case 'PROVIDER': {
      if (input.providerId === undefined || input.providerId === null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'PROVIDER base budget requires a resolved quote providerId',
          { details: { budgetPeriodId: input.budgetPeriodId } },
        );
      }
      if (row.scope_reference_id === null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'PROVIDER base budget requires non-null scope_reference_id',
          { details: { budgetPeriodId: input.budgetPeriodId } },
        );
      }
      if (row.scope_reference_id !== input.providerId) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'PROVIDER base budget scope_reference_id does not match quote provider',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              scopeReferenceId: row.scope_reference_id,
              providerId: input.providerId,
            },
          },
        );
      }
      requireExactCountryMatch(
        row.country_group,
        input.countryGroup,
        input.budgetPeriodId,
        'PROVIDER base budget',
      );
      break;
    }
    case 'COUNTRY_GROUP': {
      if (row.country_group === null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'COUNTRY_GROUP base budget requires non-null country_group',
          { details: { budgetPeriodId: input.budgetPeriodId } },
        );
      }
      if (row.scope_reference_id !== null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'COUNTRY_GROUP base budget must not use scope_reference_id as authority',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              scopeReferenceId: row.scope_reference_id,
            },
          },
        );
      }
      if (input.countryGroup === undefined || input.countryGroup === null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'COUNTRY_GROUP base budget requires quote countryGroup',
          { details: { budgetPeriodId: input.budgetPeriodId } },
        );
      }
      if (input.countryGroup !== row.country_group) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'COUNTRY_GROUP base budget country_group does not match quote',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              budgetCountryGroup: row.country_group,
              quoteCountryGroup: input.countryGroup,
            },
          },
        );
      }
      break;
    }
    case 'REWARD_RULE': {
      if (row.scope_reference_id === null) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'REWARD_RULE base budget requires scope_reference_id = reward rule id',
          { details: { budgetPeriodId: input.budgetPeriodId } },
        );
      }
      if (row.scope_reference_id !== input.rewardRuleId) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'REWARD_RULE base budget does not match resolved reward rule id',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              scopeReferenceId: row.scope_reference_id,
              rewardRuleId: input.rewardRuleId,
            },
          },
        );
      }
      if (row.rule_version !== null && row.rule_version !== input.ruleVersion) {
        throw new RewardDomainError(
          'BUDGET_SCOPE_MISMATCH',
          'REWARD_RULE base budget rule_version does not match resolved rule',
          {
            details: {
              budgetPeriodId: input.budgetPeriodId,
              budgetRuleVersion: row.rule_version,
              ruleVersion: input.ruleVersion,
            },
          },
        );
      }
      requireExactCountryMatch(
        row.country_group,
        input.countryGroup,
        input.budgetPeriodId,
        'REWARD_RULE base budget',
      );
      break;
    }
    default:
      throw new RewardDomainError(
        'BUDGET_SCOPE_MISMATCH',
        'unsupported Phase 5 base budget scope_type',
        { details: { budgetPeriodId: input.budgetPeriodId, scopeType: row.scope_type } },
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

  const applicable = result.rows.map((row) => {
    assertCanonicalBudgetWindow(
      row.granularity,
      row.period_start,
      row.period_end,
      'membership bonus budget period',
    );
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
  });

  if (input.locatorPeriodIds !== undefined && input.locatorPeriodIds.length > 0) {
    const applicableIds = new Set(applicable.map((p) => p.id));
    for (const locatorId of input.locatorPeriodIds) {
      if (!applicableIds.has(locatorId)) {
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
  assertCanonicalBudgetWindow(
    row.granularity,
    row.period_start,
    row.period_end,
    'membership bonus budget period',
  );
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
