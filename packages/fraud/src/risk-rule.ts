import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';

export type RiskRuleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Allowlisted V1 action codes stored as DATA in risk_rule_versions.actions. */
export const RISK_ACTION_CODES = [
  'ALLOW',
  'EXTEND_PENDING',
  'MANUAL_REVIEW',
  'HELD',
  'WITHDRAWAL_BLOCKED',
  'REJECTED_PRE_BROADCAST',
  'SUSPEND_EARNING',
  'FREEZE_ACCOUNT',
] as const;

export type RiskActionCode = (typeof RISK_ACTION_CODES)[number];

const RISK_ACTION_SET = new Set<string>(RISK_ACTION_CODES);
const RISK_TIER_KEYS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const SIGNAL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Shape-only thresholds. Numeric values are validated for range/order; production
 * band numbers are NOT invented by this package and must come from stored rule data.
 */
export interface RiskThresholdsConfig {
  readonly lowMax: number;
  readonly mediumMax: number;
  readonly highMax: number;
}

export type RiskSignalWeightsConfig = Readonly<Record<string, number>>;

export type RiskActionsConfig = Readonly<Record<RiskTier, RiskActionCode>>;

export interface RiskRuleVersion {
  readonly id: string;
  readonly ruleVersion: number;
  readonly thresholds: RiskThresholdsConfig;
  readonly signalWeights: RiskSignalWeightsConfig;
  readonly actions: RiskActionsConfig;
  readonly status: RiskRuleStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly auditReference: string | null;
}

export type ResolvedRiskRuleVersion = RiskRuleVersion & {
  readonly status: 'ACTIVE';
};

interface RiskRuleRow {
  readonly id: string;
  readonly rule_version: number;
  readonly thresholds: unknown;
  readonly signal_weights: unknown;
  readonly actions: unknown;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly audit_reference: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertIntegerInRange(
  label: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    throw new FraudDomainError(
      'RISK_RULE_CONFIG_INVALID',
      `${label} must be an integer`,
      { label, value },
    );
  }
  if (value < min || value > max) {
    throw new FraudDomainError(
      'RISK_RULE_CONFIG_INVALID',
      `${label} must be between ${min} and ${max}`,
      { label, value },
    );
  }
  return value;
}

function assertNoUnsupportedKeys(
  label: string,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new FraudDomainError(
        'RISK_RULE_CONFIG_INVALID',
        `${label} has unsupported key ${key}`,
        { label, key },
      );
    }
  }
}

/** Validate thresholds JSONB shape/range — does not invent production band values. */
export function parseRiskThresholds(raw: unknown): RiskThresholdsConfig {
  if (!isPlainObject(raw)) {
    throw new FraudDomainError('RISK_RULE_CONFIG_INVALID', 'thresholds must be an object');
  }
  assertNoUnsupportedKeys(
    'thresholds',
    raw,
    new Set(['lowMax', 'mediumMax', 'highMax']),
  );
  const lowMax = assertIntegerInRange('thresholds.lowMax', raw.lowMax, 0, 100);
  const mediumMax = assertIntegerInRange('thresholds.mediumMax', raw.mediumMax, 0, 100);
  const highMax = assertIntegerInRange('thresholds.highMax', raw.highMax, 0, 100);
  if (!(lowMax < mediumMax && mediumMax < highMax)) {
    throw new FraudDomainError(
      'RISK_RULE_CONFIG_INVALID',
      'thresholds must satisfy lowMax < mediumMax < highMax',
      { lowMax, mediumMax, highMax },
    );
  }
  return { lowMax, mediumMax, highMax };
}

/** Validate signal_weights JSONB — integer weights only; keys are allowlisted signal codes. */
export function parseRiskSignalWeights(raw: unknown): RiskSignalWeightsConfig {
  if (!isPlainObject(raw)) {
    throw new FraudDomainError('RISK_RULE_CONFIG_INVALID', 'signal_weights must be an object');
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SIGNAL_CODE_PATTERN.test(key)) {
      throw new FraudDomainError(
        'RISK_RULE_CONFIG_INVALID',
        `signal_weights key ${key} is not a valid signal code`,
        { key },
      );
    }
    out[key] = assertIntegerInRange(`signal_weights.${key}`, value, 0, 100);
  }
  return out;
}

/** Validate actions JSONB — every risk tier must map to an allowlisted action code. */
export function parseRiskActions(raw: unknown): RiskActionsConfig {
  if (!isPlainObject(raw)) {
    throw new FraudDomainError('RISK_RULE_CONFIG_INVALID', 'actions must be an object');
  }
  assertNoUnsupportedKeys('actions', raw, new Set(RISK_TIER_KEYS));
  const out = {} as Record<RiskTier, RiskActionCode>;
  for (const tier of RISK_TIER_KEYS) {
    const value = raw[tier];
    if (typeof value !== 'string' || !RISK_ACTION_SET.has(value)) {
      throw new FraudDomainError(
        'RISK_RULE_CONFIG_INVALID',
        `actions.${tier} must be an allowlisted action code`,
        { tier, value },
      );
    }
    out[tier] = value as RiskActionCode;
  }
  return out;
}

export function validateRiskRuleConfig(input: {
  readonly thresholds: unknown;
  readonly signalWeights: unknown;
  readonly actions: unknown;
}): {
  readonly thresholds: RiskThresholdsConfig;
  readonly signalWeights: RiskSignalWeightsConfig;
  readonly actions: RiskActionsConfig;
} {
  return {
    thresholds: parseRiskThresholds(input.thresholds),
    signalWeights: parseRiskSignalWeights(input.signalWeights),
    actions: parseRiskActions(input.actions),
  };
}

function mapRow(row: RiskRuleRow): RiskRuleVersion {
  const config = validateRiskRuleConfig({
    thresholds: row.thresholds,
    signalWeights: row.signal_weights,
    actions: row.actions,
  });
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'SUPERSEDED' &&
    row.status !== 'REVOKED'
  ) {
    throw new FraudDomainError('RISK_RULE_INTEGRITY', `invalid risk rule status ${row.status}`);
  }
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    thresholds: config.thresholds,
    signalWeights: config.signalWeights,
    actions: config.actions,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    auditReference: row.audit_reference,
  };
}

/**
 * Resolve the single ACTIVE risk rule applicable at `at` (default now).
 * Fail closed when zero or multiple rows match — never invent thresholds.
 */
export async function resolveActiveRiskRuleVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedRiskRuleVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<RiskRuleRow>(
    `SELECT id, rule_version, thresholds, signal_weights, actions, status::text AS status,
            effective_from, effective_to, reason, audit_reference
     FROM risk_rule_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY rule_version ASC`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new FraudDomainError(
      'RISK_RULE_NOT_CONFIGURED',
      'No ACTIVE risk rule version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new FraudDomainError(
      'RISK_RULE_INTEGRITY',
      'Multiple ACTIVE risk rule versions apply at the same instant',
      {
        at: at.toISOString(),
        ruleVersions: result.rows.map((row) => row.rule_version),
      },
    );
  }

  const mapped = mapRow(result.rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new FraudDomainError('RISK_RULE_INTEGRITY', 'Resolved risk rule is not ACTIVE');
  }
  return mapped as ResolvedRiskRuleVersion;
}

/** Load a historical rule by immutable rule_version number (any status). */
export async function loadRiskRuleVersionByNumber(
  client: PoolClient,
  ruleVersion: number,
): Promise<RiskRuleVersion> {
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new FraudDomainError('RISK_RULE_CONFIG_INVALID', 'ruleVersion must be a positive integer');
  }
  const result = await client.query<RiskRuleRow>(
    `SELECT id, rule_version, thresholds, signal_weights, actions, status::text AS status,
            effective_from, effective_to, reason, audit_reference
     FROM risk_rule_versions
     WHERE rule_version = $1`,
    [ruleVersion],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError('RISK_RULE_NOT_FOUND', `risk rule version ${ruleVersion} not found`, {
      ruleVersion,
    });
  }
  return mapRow(row);
}
