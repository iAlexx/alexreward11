import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import {
  lockOrCreateExposurePeriod,
  windowForLimitCode,
  type ExposurePeriodWindow,
} from './exposure.js';
import type {
  EnvironmentName,
  EvaluatedExposureLimitSnapshot,
  GuardrailEvaluation,
  MembershipBonusUnavailablePolicy,
  PendingExposureReservation,
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

function limitAppliesToQuote(
  limit: {
    limit_code: string;
    scope_reference_id: string | null;
    country_group: string | null;
  },
  input: {
    readonly providerId?: string | null;
    readonly countryGroup?: string | null;
  },
): boolean {
  if (limit.limit_code === 'MAX_PROVIDER_DAILY_REWARD_EXPENSE') {
    if (limit.scope_reference_id === null) return false;
    if (input.providerId === undefined || input.providerId === null) return false;
    return limit.scope_reference_id === input.providerId;
  }
  if (limit.limit_code === 'MAX_COUNTRY_DAILY_REWARD_EXPENSE') {
    if (limit.country_group === null) return false;
    if (input.countryGroup === undefined || input.countryGroup === null) return false;
    return limit.country_group === input.countryGroup;
  }
  if (
    limit.limit_code === 'MAX_GLOBAL_HOURLY_REWARD_EXPENSE' ||
    limit.limit_code === 'MAX_GLOBAL_DAILY_REWARD_EXPENSE' ||
    limit.limit_code === 'MAX_MEMBERSHIP_BONUS_DAILY' ||
    limit.limit_code === 'MAX_MEMBERSHIP_BONUS_MONTHLY'
  ) {
    return true;
  }
  return false;
}

function candidateForLimit(
  limitCode: string,
  baseAmountAtomic: bigint,
  membershipBonusAmountAtomic: bigint,
): bigint | null {
  if (
    limitCode === 'MAX_GLOBAL_HOURLY_REWARD_EXPENSE' ||
    limitCode === 'MAX_GLOBAL_DAILY_REWARD_EXPENSE' ||
    limitCode === 'MAX_PROVIDER_DAILY_REWARD_EXPENSE' ||
    limitCode === 'MAX_COUNTRY_DAILY_REWARD_EXPENSE'
  ) {
    return baseAmountAtomic;
  }
  if (limitCode === 'MAX_MEMBERSHIP_BONUS_DAILY' || limitCode === 'MAX_MEMBERSHIP_BONUS_MONTHLY') {
    return membershipBonusAmountAtomic > 0n ? membershipBonusAmountAtomic : null;
  }
  return null;
}

/**
 * Evaluate kill switches / exposure / margin before authorizing a new quote.
 * Reserves exposure capacity under row locks when limits allow (pending until quote insert).
 * Never mutates already-started quotes.
 *
 * MIN_EXPECTED_MARGIN_BPS: fail-closed OWNER_DECISION_REQUIRED — V1.2 does not approve a
 * simplistic (10000 - user_share_bps) formula as expected margin.
 */
export async function evaluateNewQuoteGuardrails(
  client: PoolClient,
  input: {
    readonly environment: EnvironmentName;
    readonly assetId: string;
    readonly rule: RewardRuleRecord;
    readonly baseAmountAtomic: bigint;
    readonly membershipBonusAmountAtomic?: bigint;
    readonly providerId?: string | null;
    readonly countryGroup?: string | null;
    readonly asOf?: Date;
  },
): Promise<GuardrailEvaluation> {
  const asOf = input.asOf ?? new Date();
  const bonusAmount = input.membershipBonusAmountAtomic ?? 0n;
  const reasons: string[] = [];
  const exposureLimitVersionIds: string[] = [];
  const evaluatedExposureLimits: EvaluatedExposureLimitSnapshot[] = [];
  const pendingExposureReservations: PendingExposureReservation[] = [];

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
    asset_id: string | null;
    rule_version: number;
    effective_from: Date;
    effective_to: Date | null;
  }>(
    `SELECT id, limit_code::text AS limit_code, limit_atomic::text AS limit_atomic, limit_bps,
            scope_reference_id, country_group, asset_id, rule_version,
            effective_from, effective_to
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
    exposureLimitVersionIds.push(limit.id);

    if (limit.limit_code === 'MIN_EXPECTED_MARGIN_BPS') {
      reasons.push('MIN_EXPECTED_MARGIN_BPS');
      evaluatedExposureLimits.push({
        id: limit.id,
        ruleVersion: limit.rule_version,
        limitCode: limit.limit_code,
        scopeReferenceId: limit.scope_reference_id,
        countryGroup: limit.country_group,
        assetId: limit.asset_id,
        limitAtomic: limit.limit_atomic,
        limitBps: limit.limit_bps,
        effectiveFrom: limit.effective_from.toISOString(),
        effectiveTo: limit.effective_to?.toISOString() ?? null,
        periodStart: null,
        periodEnd: null,
        decision: 'OWNER_DECISION_REQUIRED',
        candidateAmountAtomic: null,
      });
      continue;
    }

    if (!limitAppliesToQuote(limit, input)) {
      // Limit is active but out of scope for this quote — still freeze evidence as ALLOW skip?
      // Owner: "all materially evaluated active financial limits". Out-of-scope provider/country
      // limits are not material for this quote; do not reserve. Keep ID for reconstruction.
      evaluatedExposureLimits.push({
        id: limit.id,
        ruleVersion: limit.rule_version,
        limitCode: limit.limit_code,
        scopeReferenceId: limit.scope_reference_id,
        countryGroup: limit.country_group,
        assetId: limit.asset_id,
        limitAtomic: limit.limit_atomic,
        limitBps: limit.limit_bps,
        effectiveFrom: limit.effective_from.toISOString(),
        effectiveTo: limit.effective_to?.toISOString() ?? null,
        periodStart: null,
        periodEnd: null,
        decision: 'ALLOW',
        candidateAmountAtomic: null,
      });
      continue;
    }

    const candidate = candidateForLimit(limit.limit_code, input.baseAmountAtomic, bonusAmount);
    if (candidate === null) {
      evaluatedExposureLimits.push({
        id: limit.id,
        ruleVersion: limit.rule_version,
        limitCode: limit.limit_code,
        scopeReferenceId: limit.scope_reference_id,
        countryGroup: limit.country_group,
        assetId: limit.asset_id,
        limitAtomic: limit.limit_atomic,
        limitBps: limit.limit_bps,
        effectiveFrom: limit.effective_from.toISOString(),
        effectiveTo: limit.effective_to?.toISOString() ?? null,
        periodStart: null,
        periodEnd: null,
        decision: 'ALLOW',
        candidateAmountAtomic: null,
      });
      continue;
    }

    if (limit.limit_atomic === null) {
      evaluatedExposureLimits.push({
        id: limit.id,
        ruleVersion: limit.rule_version,
        limitCode: limit.limit_code,
        scopeReferenceId: limit.scope_reference_id,
        countryGroup: limit.country_group,
        assetId: limit.asset_id,
        limitAtomic: null,
        limitBps: limit.limit_bps,
        effectiveFrom: limit.effective_from.toISOString(),
        effectiveTo: limit.effective_to?.toISOString() ?? null,
        periodStart: null,
        periodEnd: null,
        decision: 'ALLOW',
        candidateAmountAtomic: amountAtomicToString(candidate),
      });
      continue;
    }

    const window: ExposurePeriodWindow | null = windowForLimitCode(limit.limit_code, asOf);
    if (window === null) {
      evaluatedExposureLimits.push({
        id: limit.id,
        ruleVersion: limit.rule_version,
        limitCode: limit.limit_code,
        scopeReferenceId: limit.scope_reference_id,
        countryGroup: limit.country_group,
        assetId: limit.asset_id,
        limitAtomic: limit.limit_atomic,
        limitBps: limit.limit_bps,
        effectiveFrom: limit.effective_from.toISOString(),
        effectiveTo: limit.effective_to?.toISOString() ?? null,
        periodStart: null,
        periodEnd: null,
        decision: 'ALLOW',
        candidateAmountAtomic: amountAtomicToString(candidate),
      });
      continue;
    }

    const period = await lockOrCreateExposurePeriod(client, {
      exposureLimitId: limit.id,
      limitAtomic: BigInt(limit.limit_atomic),
      window,
    });
    const remaining =
      BigInt(period.limit_atomic) -
      BigInt(period.reserved_atomic) -
      BigInt(period.consumed_atomic);
    const decision: 'ALLOW' | 'BLOCK' = candidate <= remaining ? 'ALLOW' : 'BLOCK';
    evaluatedExposureLimits.push({
      id: limit.id,
      ruleVersion: limit.rule_version,
      limitCode: limit.limit_code,
      scopeReferenceId: limit.scope_reference_id,
      countryGroup: limit.country_group,
      assetId: limit.asset_id,
      limitAtomic: limit.limit_atomic,
      limitBps: limit.limit_bps,
      effectiveFrom: limit.effective_from.toISOString(),
      effectiveTo: limit.effective_to?.toISOString() ?? null,
      periodStart: window.periodStart.toISOString(),
      periodEnd: window.periodEnd.toISOString(),
      decision,
      candidateAmountAtomic: amountAtomicToString(candidate),
    });
    if (decision === 'BLOCK') {
      reasons.push(limit.limit_code);
    } else {
      pendingExposureReservations.push({
        exposurePeriodId: period.id,
        amountAtomic: candidate,
        limitId: limit.id,
        limitCode: limit.limit_code,
      });
    }
  }

  const marginBlocked = reasons.includes('MIN_EXPECTED_MARGIN_BPS');
  if (marginBlocked) {
    throw new RewardDomainError(
      'MARGIN_POLICY_UNDEFINED',
      'MIN_EXPECTED_MARGIN_BPS is ACTIVE but expected-margin formula is OWNER_DECISION_REQUIRED',
      { details: { reasons } },
    );
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    exposureLimitVersionIds: [...new Set(exposureLimitVersionIds)],
    evaluatedExposureLimits,
    pendingExposureReservations,
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
