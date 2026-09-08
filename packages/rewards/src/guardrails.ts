import type { PoolClient } from 'pg';

import { RewardDomainError } from './errors.js';
import type {
  EnvironmentName,
  GuardrailEvaluation,
  MembershipBonusUnavailablePolicy,
  RewardRuleRecord,
} from './types.js';

async function isFlagEnabled(
  client: PoolClient,
  flagKey: string,
  environment: EnvironmentName,
): Promise<boolean> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = $1 AND environment = $2::environment_name`,
    [flagKey, environment],
  );
  return result.rows[0]?.enabled === true;
}

/**
 * Evaluate kill switches / exposure / margin before authorizing a new quote.
 * Never mutates already-started quotes.
 */
export async function evaluateNewQuoteGuardrails(
  client: PoolClient,
  input: {
    readonly environment: EnvironmentName;
    readonly assetId: string;
    readonly rule: RewardRuleRecord;
    readonly baseAmountAtomic: bigint;
    readonly providerId?: string | null;
    readonly countryGroup?: string | null;
    readonly asOf?: Date;
  },
): Promise<GuardrailEvaluation> {
  const asOf = input.asOf ?? new Date();
  const reasons: string[] = [];
  const exposureLimitVersionIds: string[] = [];

  if (await isFlagEnabled(client, 'GLOBAL_REWARDS_PAUSE', input.environment)) {
    reasons.push('GLOBAL_REWARDS_PAUSE');
  }

  const limits = await client.query<{
    id: string;
    limit_code: string;
    limit_atomic: string | null;
    limit_bps: number | null;
    scope_reference_id: string | null;
    country_group: string | null;
  }>(
    `SELECT id, limit_code::text AS limit_code, limit_atomic::text AS limit_atomic, limit_bps,
            scope_reference_id, country_group
     FROM economic_exposure_limits
     WHERE status = 'ACTIVE'
       AND environment = $1::environment_name
       AND effective_from <= $2::timestamptz
       AND (effective_to IS NULL OR effective_to > $2::timestamptz)
       AND (asset_id IS NULL OR asset_id = $3::uuid)
     ORDER BY id ASC`,
    [input.environment, asOf.toISOString(), input.assetId],
  );

  for (const limit of limits.rows) {
    if (
      limit.limit_code === 'MIN_EXPECTED_MARGIN_BPS' &&
      limit.limit_bps !== null &&
      input.rule.userShareBps !== null
    ) {
      const impliedMarginBps = 10_000 - input.rule.userShareBps;
      if (impliedMarginBps < limit.limit_bps) {
        reasons.push('MIN_EXPECTED_MARGIN_BPS');
        exposureLimitVersionIds.push(limit.id);
      }
      continue;
    }

    if (limit.limit_atomic === null) continue;

    if (
      limit.limit_code === 'MAX_PROVIDER_DAILY_REWARD_EXPENSE' &&
      limit.scope_reference_id !== null &&
      input.providerId !== null &&
      input.providerId !== undefined &&
      limit.scope_reference_id !== input.providerId
    ) {
      continue;
    }
    if (
      limit.limit_code === 'MAX_COUNTRY_DAILY_REWARD_EXPENSE' &&
      limit.country_group !== null &&
      input.countryGroup !== null &&
      input.countryGroup !== undefined &&
      limit.country_group !== input.countryGroup
    ) {
      continue;
    }

    if (limit.limit_code.startsWith('MAX_') && limit.limit_code.includes('REWARD_EXPENSE')) {
      const spent = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(reserved_atomic + consumed_atomic), 0)::text AS total
         FROM reward_budget_periods
         WHERE asset_id = $1::uuid AND status = 'ACTIVE'`,
        [input.assetId],
      );
      const total = BigInt(spent.rows[0]?.total ?? '0') + input.baseAmountAtomic;
      if (total > BigInt(limit.limit_atomic)) {
        reasons.push(limit.limit_code);
        exposureLimitVersionIds.push(limit.id);
      }
    }

    if (limit.limit_code.startsWith('MAX_MEMBERSHIP_BONUS')) {
      const spent = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(reserved_atomic + consumed_atomic), 0)::text AS total
         FROM membership_bonus_budget_periods
         WHERE asset_id = $1::uuid AND status = 'ACTIVE'`,
        [input.assetId],
      );
      const total = BigInt(spent.rows[0]?.total ?? '0');
      if (total > BigInt(limit.limit_atomic)) {
        reasons.push(limit.limit_code);
        exposureLimitVersionIds.push(limit.id);
      }
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    exposureLimitVersionIds: [...new Set(exposureLimitVersionIds)],
  };
}

export async function assertNewQuotesAllowed(
  client: PoolClient,
  input: Parameters<typeof evaluateNewQuoteGuardrails>[1],
): Promise<GuardrailEvaluation> {
  const evaluation = await evaluateNewQuoteGuardrails(client, input);
  if (evaluation.blocked) {
    throw new RewardDomainError(
      'GUARDRAIL_BLOCKED',
      'new reward quotes are blocked by guardrails',
      {
        details: { reasons: evaluation.reasons },
      },
    );
  }
  return evaluation;
}

export async function isMembershipBonusPaused(
  client: PoolClient,
  environment: EnvironmentName,
): Promise<boolean> {
  return isFlagEnabled(client, 'MEMBERSHIP_BONUS_PAUSE', environment);
}

export function requireBonusUnavailablePolicy(
  evaluateMembershipBonus: boolean,
  policy: MembershipBonusUnavailablePolicy | null | undefined,
): MembershipBonusUnavailablePolicy | null {
  if (!evaluateMembershipBonus) return null;
  if (policy === undefined || policy === null) {
    throw new RewardDomainError(
      'BONUS_POLICY_REQUIRED',
      'bonusUnavailablePolicy is required when membership bonus evaluation is in scope',
    );
  }
  return policy;
}
