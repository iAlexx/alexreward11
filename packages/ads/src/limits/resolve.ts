import type { PoolClient } from 'pg';

import { HARD_LIMIT_SCOPES } from '../constants.js';
import { withLedgerTransaction, type AdsDb } from '../db.js';
import { AdsDomainError } from '../errors.js';
import type {
  ProviderLimitMetric,
  ProviderLimitRuleRecord,
  ProviderLimitRuleVersionRef,
  ProviderLimitScope,
  ProviderLimitWindow,
  RiskTier,
} from '../types.js';

export interface ResolveEffectiveProviderLimitsInput {
  readonly providerId: string;
  readonly asOf: Date;
  readonly countryCode?: string | null;
  readonly riskTier?: RiskTier | null;
}

export interface EffectiveProviderLimitDimension {
  readonly metric: ProviderLimitMetric;
  readonly window: ProviderLimitWindow;
  /** Safest (minimum) applicable max_count across every ACTIVE rule on this dimension. */
  readonly maxCount: number;
  /** Longest applicable cooldown; null when no applicable rule defines one. */
  readonly cooldownSeconds: number | null;
  readonly decidingRule: ProviderLimitRuleVersionRef;
  /** Minimum PROVIDER_HARD/CONTRACT ceiling on this dimension, when one exists. */
  readonly hardCeilingMaxCount: number | null;
  readonly applicableRules: readonly ProviderLimitRuleRecord[];
}

export interface EffectiveProviderLimits {
  readonly providerId: string;
  readonly asOf: string;
  readonly countryCode: string | null;
  readonly riskTier: RiskTier | null;
  readonly requestUtcDay: EffectiveProviderLimitDimension | null;
  readonly successUtcDay: EffectiveProviderLimitDimension | null;
  readonly byDimension: readonly EffectiveProviderLimitDimension[];
  /** Full audit trail of every rule version that contributed to the decision. */
  readonly ruleVersions: readonly ProviderLimitRuleVersionRef[];
}

interface LimitRuleRow {
  id: string;
  provider_id: string;
  limit_scope: ProviderLimitScope;
  limit_metric: ProviderLimitMetric;
  limit_window: ProviderLimitWindow;
  country_code: string | null;
  risk_tier: RiskTier | null;
  max_count: number;
  cooldown_seconds: number | null;
  rule_version: number;
  source_type: ProviderLimitRuleRecord['sourceType'];
  source_reference: string;
  valid_from: Date;
  valid_to: Date | null;
  approved_by_admin_id: string | null;
  approved_at: Date | null;
}

/** Lower rank wins a max_count tie: an absolute ceiling outranks a platform preference. */
const SCOPE_AUTHORITY_RANK: Readonly<Record<ProviderLimitScope, number>> = {
  PROVIDER_HARD: 0,
  CONTRACT: 1,
  COUNTRY_OVERRIDE: 2,
  USER_TIER: 3,
  PLATFORM_SOFT: 4,
};

function toRuleRecord(row: LimitRuleRow): ProviderLimitRuleRecord {
  return {
    ruleId: row.id,
    ruleVersion: row.rule_version,
    limitScope: row.limit_scope,
    limitMetric: row.limit_metric,
    limitWindow: row.limit_window,
    maxCount: row.max_count,
    sourceType: row.source_type,
    sourceReference: row.source_reference,
    providerId: row.provider_id,
    countryCode: row.country_code,
    riskTier: row.risk_tier,
    cooldownSeconds: row.cooldown_seconds,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to === null ? null : row.valid_to.toISOString(),
    approvedByAdminId: row.approved_by_admin_id,
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
  };
}

function toVersionRef(rule: ProviderLimitRuleRecord): ProviderLimitRuleVersionRef {
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    limitScope: rule.limitScope,
    limitMetric: rule.limitMetric,
    limitWindow: rule.limitWindow,
    maxCount: rule.maxCount,
    sourceType: rule.sourceType,
    sourceReference: rule.sourceReference,
  };
}

function dimensionKey(metric: ProviderLimitMetric, window: ProviderLimitWindow): string {
  return `${metric}:${window}`;
}

function reduceDimension(
  metric: ProviderLimitMetric,
  window: ProviderLimitWindow,
  rules: readonly ProviderLimitRuleRecord[],
): EffectiveProviderLimitDimension {
  const ordered = [...rules].sort((a, b) => {
    if (a.maxCount !== b.maxCount) return a.maxCount - b.maxCount;
    const rankDelta = SCOPE_AUTHORITY_RANK[a.limitScope] - SCOPE_AUTHORITY_RANK[b.limitScope];
    if (rankDelta !== 0) return rankDelta;
    if (a.ruleVersion !== b.ruleVersion) return b.ruleVersion - a.ruleVersion;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  const deciding = ordered[0];
  if (deciding === undefined) {
    throw new AdsDomainError('INTERNAL', 'limit dimension reduced with no applicable rules', {
      details: { metric, window },
    });
  }

  const cooldowns = ordered
    .map((rule) => rule.cooldownSeconds)
    .filter((value): value is number => value !== null);

  const hardCeilings = ordered
    .filter((rule) => HARD_LIMIT_SCOPES.includes(rule.limitScope))
    .map((rule) => rule.maxCount);

  return {
    metric,
    window,
    maxCount: deciding.maxCount,
    cooldownSeconds: cooldowns.length === 0 ? null : Math.max(...cooldowns),
    decidingRule: toVersionRef(deciding),
    hardCeilingMaxCount: hardCeilings.length === 0 ? null : Math.min(...hardCeilings),
    applicableRules: ordered,
  };
}

/**
 * Resolve the effective provider limits from versioned `provider_limit_rules` data.
 *
 * Per dimension (limit_metric + limit_window) every applicable ACTIVE rule is collected
 * and the **minimum** max_count wins, so a platform/user/country rule can only ever be
 * stricter than a provider or contract hard limit, never looser (Spec V1.3 §2.1).
 *
 * No numeric limit is hardcoded here. Replacing an approved provider value is an Owner
 * configuration change (a new approved rule version), not a code change.
 */
export async function resolveEffectiveProviderLimits(
  db: AdsDb,
  input: ResolveEffectiveProviderLimitsInput,
): Promise<EffectiveProviderLimits> {
  return withLedgerTransaction(db, (client) => resolveOnClient(client, input));
}

async function resolveOnClient(
  client: PoolClient,
  input: ResolveEffectiveProviderLimitsInput,
): Promise<EffectiveProviderLimits> {
  const countryCode = input.countryCode ?? null;
  const riskTier = input.riskTier ?? null;

  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    throw new AdsDomainError('VALIDATION', 'countryCode must be an uppercase ISO-3166-1 alpha-2');
  }

  const result = await client.query<LimitRuleRow>(
    `SELECT id,
            provider_id,
            limit_scope::text AS limit_scope,
            limit_metric::text AS limit_metric,
            limit_window::text AS limit_window,
            country_code,
            risk_tier::text AS risk_tier,
            max_count,
            cooldown_seconds,
            rule_version,
            source_type::text AS source_type,
            source_reference,
            valid_from,
            valid_to,
            approved_by_admin_id,
            approved_at
     FROM provider_limit_rules
     WHERE provider_id = $1::uuid
       AND status = 'ACTIVE'
       AND valid_from <= $2::timestamptz
       AND (valid_to IS NULL OR valid_to > $2::timestamptz)
       AND (country_code IS NULL OR country_code = $3)
       AND (risk_tier IS NULL OR risk_tier = $4::risk_tier)
     ORDER BY limit_metric, limit_window, max_count, rule_version DESC, id`,
    [input.providerId, input.asOf.toISOString(), countryCode, riskTier],
  );

  const grouped = new Map<string, ProviderLimitRuleRecord[]>();
  for (const row of result.rows) {
    const rule = toRuleRecord(row);
    const key = dimensionKey(rule.limitMetric, rule.limitWindow);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [rule]);
    } else {
      bucket.push(rule);
    }
  }

  const byDimension: EffectiveProviderLimitDimension[] = [];
  for (const [key, rules] of [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [metric, window] = key.split(':') as [ProviderLimitMetric, ProviderLimitWindow];
    byDimension.push(reduceDimension(metric, window, rules));
  }

  const ruleVersions = byDimension.flatMap((dimension) =>
    dimension.applicableRules.map(toVersionRef),
  );

  return {
    providerId: input.providerId,
    asOf: input.asOf.toISOString(),
    countryCode,
    riskTier,
    requestUtcDay: findDimension(byDimension, 'REQUEST', 'UTC_DAY'),
    successUtcDay: findDimension(byDimension, 'SUCCESS', 'UTC_DAY'),
    byDimension,
    ruleVersions,
  };
}

export function findDimension(
  dimensions: readonly EffectiveProviderLimitDimension[],
  metric: ProviderLimitMetric,
  window: ProviderLimitWindow,
): EffectiveProviderLimitDimension | null {
  return (
    dimensions.find((dimension) => dimension.metric === metric && dimension.window === window) ??
    null
  );
}

/**
 * Require a dimension to be configured. Missing approved limit data fails closed:
 * the platform never invents a default cap.
 */
export function requireDimension(
  limits: EffectiveProviderLimits,
  metric: ProviderLimitMetric,
  window: ProviderLimitWindow,
): EffectiveProviderLimitDimension {
  const dimension = findDimension(limits.byDimension, metric, window);
  if (dimension === null) {
    throw new AdsDomainError(
      'LIMIT_RULE_MISSING',
      'no ACTIVE provider limit rule for required dimension',
      { details: { providerId: limits.providerId, metric, window, asOf: limits.asOf } },
    );
  }
  return dimension;
}
