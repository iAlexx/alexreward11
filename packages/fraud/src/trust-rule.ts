import type { PoolClient } from 'pg';

import { isPlainJsonObject } from './canonical.js';
import { FraudDomainError } from './errors.js';

export type TrustRuleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

/** Allowlisted Trust signal codes for versioned policy_config.signals. */
export const TRUST_SIGNAL_CODES = [
  'ACCOUNT_AGE',
  'VERIFIED_PRIMARY_WALLET_AGE',
  'REWARDED_AD_HISTORY',
  'CONFIRMED_PAYOUT_HISTORY',
] as const;

export type TrustSignalCode = (typeof TRUST_SIGNAL_CODES)[number];

const TRUST_SIGNAL_CODE_SET = new Set<string>(TRUST_SIGNAL_CODES);

export interface TrustAccountAgeSignalConfig {
  readonly weight: number;
  readonly minDays: number;
}

export interface TrustVerifiedPrimaryWalletAgeSignalConfig {
  readonly weight: number;
  readonly minDays: number;
}

export interface TrustRewardedAdHistorySignalConfig {
  readonly weight: number;
  readonly minCount: number;
}

export interface TrustConfirmedPayoutHistorySignalConfig {
  readonly weight: number;
  readonly minCount: number;
}

export interface TrustPolicySignalsConfig {
  readonly ACCOUNT_AGE?: TrustAccountAgeSignalConfig;
  readonly VERIFIED_PRIMARY_WALLET_AGE?: TrustVerifiedPrimaryWalletAgeSignalConfig;
  readonly REWARDED_AD_HISTORY?: TrustRewardedAdHistorySignalConfig;
  readonly CONFIRMED_PAYOUT_HISTORY?: TrustConfirmedPayoutHistorySignalConfig;
}

export interface TrustStateThresholdsConfig {
  readonly basicMin: number;
  readonly establishedMin: number;
  readonly trustedMin: number;
}

/**
 * Versioned Trust evaluation policy.
 * No Founder / membership / Risk-bypass fields are permitted.
 */
export interface TrustPolicyConfig {
  readonly signals: TrustPolicySignalsConfig;
  readonly stateThresholds: TrustStateThresholdsConfig;
}

/**
 * Versioned Trust rule metadata + optional parsed policy_config.
 * policyConfig is null when the DB column is NULL (unconfigured / historical DRAFT).
 */
export interface TrustRuleVersion {
  readonly id: string;
  readonly ruleVersion: number;
  readonly status: TrustRuleStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly auditReference: string | null;
  readonly policyConfig: TrustPolicyConfig | null;
}

export type ResolvedTrustRuleVersion = TrustRuleVersion & {
  readonly status: 'ACTIVE';
  readonly policyConfig: TrustPolicyConfig;
};

interface TrustRuleRow {
  readonly id: string;
  readonly rule_version: number;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly audit_reference: string | null;
  readonly policy_config: unknown;
}

const TRUST_RULE_SELECT = `SELECT id, rule_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference, policy_config`;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function configInvalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new FraudDomainError('TRUST_POLICY_CONFIG_INVALID', message, details);
}

function assertIntegerInRange(
  label: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    configInvalid(`${label} must be an integer`, { label, value });
  }
  if (value < min || value > max) {
    configInvalid(`${label} must be between ${min} and ${max}`, { label, value });
  }
  return value;
}

function assertPositiveInteger(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    configInvalid(`${label} must be an integer`, { label, value });
  }
  if (value <= 0) {
    configInvalid(`${label} must be a positive integer`, { label, value });
  }
  return value;
}

function parseAgeSignal(
  code: 'ACCOUNT_AGE' | 'VERIFIED_PRIMARY_WALLET_AGE',
  raw: unknown,
): TrustAccountAgeSignalConfig {
  if (!isPlainJsonObject(raw)) {
    configInvalid(`signals.${code} must be a plain JSON object`, { code });
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== 'weight' && key !== 'minDays') {
      configInvalid(`signals.${code} has unsupported field ${key}`, { code, key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'weight')) {
    configInvalid(`signals.${code}.weight is required`, { code });
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'minDays')) {
    configInvalid(`signals.${code}.minDays is required`, { code });
  }
  return {
    weight: assertIntegerInRange(`signals.${code}.weight`, raw.weight, 0, 100),
    minDays: assertPositiveInteger(`signals.${code}.minDays`, raw.minDays),
  };
}

function parseCountSignal(
  code: 'REWARDED_AD_HISTORY' | 'CONFIRMED_PAYOUT_HISTORY',
  raw: unknown,
): TrustRewardedAdHistorySignalConfig {
  if (!isPlainJsonObject(raw)) {
    configInvalid(`signals.${code} must be a plain JSON object`, { code });
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== 'weight' && key !== 'minCount') {
      configInvalid(`signals.${code} has unsupported field ${key}`, { code, key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'weight')) {
    configInvalid(`signals.${code}.weight is required`, { code });
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'minCount')) {
    configInvalid(`signals.${code}.minCount is required`, { code });
  }
  return {
    weight: assertIntegerInRange(`signals.${code}.weight`, raw.weight, 0, 100),
    minCount: assertPositiveInteger(`signals.${code}.minCount`, raw.minCount),
  };
}

/**
 * Strict parser for versioned Trust evaluation policy_config.
 * Does not invent defaults, repair malformed input, or define production thresholds.
 * Output is deeply frozen.
 */
export function parseTrustPolicyConfig(raw: unknown): TrustPolicyConfig {
  if (raw === null || raw === undefined) {
    configInvalid('policy_config is missing');
  }
  if (!isPlainJsonObject(raw)) {
    configInvalid('policy_config must be a plain JSON object');
  }

  const rootKeys = Object.keys(raw);
  if (rootKeys.length === 0) {
    configInvalid('policy_config root is empty');
  }
  for (const key of rootKeys) {
    if (key !== 'signals' && key !== 'stateThresholds') {
      configInvalid(`unknown policy_config root field ${key}`, { key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'signals')) {
    configInvalid('policy_config.signals is required');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'stateThresholds')) {
    configInvalid('policy_config.stateThresholds is required');
  }

  const signalsRaw = raw.signals;
  if (!isPlainJsonObject(signalsRaw)) {
    configInvalid('policy_config.signals must be a plain JSON object');
  }
  const signalKeys = Object.keys(signalsRaw);
  if (signalKeys.length === 0) {
    configInvalid('policy_config.signals must configure at least one signal');
  }

  const signals: {
    ACCOUNT_AGE?: TrustAccountAgeSignalConfig;
    VERIFIED_PRIMARY_WALLET_AGE?: TrustVerifiedPrimaryWalletAgeSignalConfig;
    REWARDED_AD_HISTORY?: TrustRewardedAdHistorySignalConfig;
    CONFIRMED_PAYOUT_HISTORY?: TrustConfirmedPayoutHistorySignalConfig;
  } = {};

  for (const code of signalKeys) {
    if (!TRUST_SIGNAL_CODE_SET.has(code)) {
      configInvalid(`unknown trust signal ${code}`, { code });
    }
    const cfg = signalsRaw[code];
    if (code === 'ACCOUNT_AGE' || code === 'VERIFIED_PRIMARY_WALLET_AGE') {
      signals[code] = parseAgeSignal(code, cfg);
    } else if (code === 'REWARDED_AD_HISTORY' || code === 'CONFIRMED_PAYOUT_HISTORY') {
      signals[code] = parseCountSignal(code, cfg);
    }
  }

  const thresholdsRaw = raw.stateThresholds;
  if (!isPlainJsonObject(thresholdsRaw)) {
    configInvalid('policy_config.stateThresholds must be a plain JSON object');
  }
  for (const key of Object.keys(thresholdsRaw)) {
    if (key !== 'basicMin' && key !== 'establishedMin' && key !== 'trustedMin') {
      configInvalid(`unknown stateThresholds field ${key}`, { key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(thresholdsRaw, 'basicMin')) {
    configInvalid('stateThresholds.basicMin is required');
  }
  if (!Object.prototype.hasOwnProperty.call(thresholdsRaw, 'establishedMin')) {
    configInvalid('stateThresholds.establishedMin is required');
  }
  if (!Object.prototype.hasOwnProperty.call(thresholdsRaw, 'trustedMin')) {
    configInvalid('stateThresholds.trustedMin is required');
  }

  const basicMin = assertIntegerInRange(
    'stateThresholds.basicMin',
    thresholdsRaw.basicMin,
    0,
    100,
  );
  const establishedMin = assertIntegerInRange(
    'stateThresholds.establishedMin',
    thresholdsRaw.establishedMin,
    0,
    100,
  );
  const trustedMin = assertIntegerInRange(
    'stateThresholds.trustedMin',
    thresholdsRaw.trustedMin,
    0,
    100,
  );
  if (!(basicMin < establishedMin && establishedMin < trustedMin)) {
    configInvalid(
      'stateThresholds must satisfy basicMin < establishedMin < trustedMin',
      { basicMin, establishedMin, trustedMin },
    );
  }

  return deepFreeze({
    signals: Object.freeze({ ...signals }),
    stateThresholds: Object.freeze({ basicMin, establishedMin, trustedMin }),
  });
}

function mapRow(row: TrustRuleRow): TrustRuleVersion {
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'SUPERSEDED' &&
    row.status !== 'REVOKED'
  ) {
    throw new FraudDomainError('TRUST_RULE_INTEGRITY', `invalid trust rule status ${row.status}`);
  }

  let policyConfig: TrustPolicyConfig | null = null;
  if (row.policy_config !== null && row.policy_config !== undefined) {
    policyConfig = parseTrustPolicyConfig(row.policy_config);
  }

  return {
    id: row.id,
    ruleVersion: row.rule_version,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    auditReference: row.audit_reference,
    policyConfig,
  };
}

function assertActiveResolved(mapped: TrustRuleVersion): ResolvedTrustRuleVersion {
  if (mapped.status !== 'ACTIVE') {
    throw new FraudDomainError('TRUST_RULE_INTEGRITY', 'Resolved trust rule is not ACTIVE');
  }
  if (mapped.policyConfig === null) {
    throw new FraudDomainError(
      'TRUST_POLICY_CONFIG_INVALID',
      'ACTIVE trust rule has NULL policy_config',
      { ruleVersion: mapped.ruleVersion },
    );
  }
  return mapped as ResolvedTrustRuleVersion;
}

/**
 * Resolve the single ACTIVE Trust rule applicable at `at` (default server now).
 * Fail closed when zero/multiple rows match or ACTIVE policy_config is missing/malformed.
 * Never invent Trust policy, never fall back to Risk rules or users table trust columns.
 */
export async function resolveActiveTrustRuleVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedTrustRuleVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<TrustRuleRow>(
    `${TRUST_RULE_SELECT}
     FROM trust_rule_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY rule_version ASC`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new FraudDomainError(
      'TRUST_RULE_NOT_CONFIGURED',
      'No ACTIVE trust rule version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new FraudDomainError(
      'TRUST_RULE_INTEGRITY',
      'Multiple ACTIVE trust rule versions apply at the same instant',
      {
        at: at.toISOString(),
        ruleVersions: result.rows.map((row) => row.rule_version),
      },
    );
  }

  const row = result.rows[0]!;
  if (row.policy_config === null || row.policy_config === undefined) {
    throw new FraudDomainError(
      'TRUST_POLICY_CONFIG_INVALID',
      'ACTIVE trust rule has NULL policy_config',
      { ruleVersion: row.rule_version },
    );
  }

  return assertActiveResolved(mapRow(row));
}

/**
 * Authoritative ACTIVE Trust-rule resolution for evaluateAndPersistTrust.
 *
 * Uses server current time only (no caller `at`). Selects the matching ACTIVE
 * row with FOR SHARE so policy_config remains stable through the caller's
 * transaction until snapshot persistence completes.
 *
 * Historical unlocked lookup remains resolveActiveTrustRuleVersion(client, { at }).
 */
export async function resolveActiveTrustRuleVersionForEvaluation(
  client: PoolClient,
): Promise<ResolvedTrustRuleVersion> {
  const at = new Date();
  const result = await client.query<TrustRuleRow>(
    `${TRUST_RULE_SELECT}
     FROM trust_rule_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY rule_version ASC
     FOR SHARE`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new FraudDomainError(
      'TRUST_RULE_NOT_CONFIGURED',
      'No ACTIVE trust rule version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new FraudDomainError(
      'TRUST_RULE_INTEGRITY',
      'Multiple ACTIVE trust rule versions apply at the same instant',
      {
        at: at.toISOString(),
        ruleVersions: result.rows.map((row) => row.rule_version),
      },
    );
  }

  const row = result.rows[0]!;
  if (row.policy_config === null || row.policy_config === undefined) {
    throw new FraudDomainError(
      'TRUST_POLICY_CONFIG_INVALID',
      'ACTIVE trust rule has NULL policy_config',
      { ruleVersion: row.rule_version },
    );
  }

  return assertActiveResolved(mapRow(row));
}

/** Load a historical Trust rule by immutable rule_version number (any status). */
export async function loadTrustRuleVersionByNumber(
  client: PoolClient,
  ruleVersion: number,
): Promise<TrustRuleVersion> {
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new FraudDomainError(
      'TRUST_SNAPSHOT_INVALID',
      'ruleVersion must be a positive integer',
      { ruleVersion },
    );
  }
  const result = await client.query<TrustRuleRow>(
    `${TRUST_RULE_SELECT}
     FROM trust_rule_versions
     WHERE rule_version = $1`,
    [ruleVersion],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'TRUST_RULE_NOT_FOUND',
      `trust rule version ${ruleVersion} not found`,
      { ruleVersion },
    );
  }
  return mapRow(row);
}

/**
 * Load a Trust rule for snapshot persistence while holding FOR SHARE
 * until the caller's transaction ends. Complements the BEFORE INSERT trigger.
 * When policy_config is present it must parse; NULL remains allowed for
 * historical / DRAFT rows used by lower-level snapshot helpers.
 */
export async function loadTrustRuleVersionForSnapshot(
  client: PoolClient,
  ruleVersion: number,
): Promise<TrustRuleVersion> {
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new FraudDomainError(
      'TRUST_SNAPSHOT_INVALID',
      'ruleVersion must be a positive integer',
      { ruleVersion },
    );
  }
  const result = await client.query<TrustRuleRow>(
    `${TRUST_RULE_SELECT}
     FROM trust_rule_versions
     WHERE rule_version = $1
     FOR SHARE`,
    [ruleVersion],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'TRUST_RULE_NOT_FOUND',
      `trust rule version ${ruleVersion} not found`,
      { ruleVersion },
    );
  }
  return mapRow(row);
}
