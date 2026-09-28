import type { PoolClient } from 'pg';

import type { EligibilityActionType } from './eligibility-decision.js';
import type { EligibilityGateCode } from './eligibility-evaluator.js';
import { FraudDomainError } from './errors.js';
import { isPlainJsonObject } from './canonical.js';
import type { RiskActionCode } from './risk-rule.js';

export type EligibilityPolicyStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

/** Runtime allowlists (duplicated to avoid circular imports with decision/evaluator). */
const ACTION_TYPE_SET = new Set<string>([
  'AD_SESSION_START',
  'WITHDRAWAL_REQUEST',
  'MISSION_CLAIM',
  'TASK_CLAIM',
  'REFERRAL_ACTIVATION',
  'MEMBERSHIP_CLAIM',
]);

const GATE_CODE_SET = new Set<string>([
  'ACCOUNT_STATE',
  'RISK_POLICY',
  'PROVIDER_LIMIT',
  'COUNTRY_POLICY',
  'MEMBERSHIP',
  'FEATURE_FLAG',
]);

/** Duplicated RiskActionCode allowlist to keep policy parsing independent of risk action execution. */
const RISK_ACTION_SET = new Set<string>([
  'ALLOW',
  'EXTEND_PENDING',
  'MANUAL_REVIEW',
  'HELD',
  'WITHDRAWAL_BLOCKED',
  'REJECTED_PRE_BROADCAST',
  'SUSPEND_EARNING',
  'FREEZE_ACCOUNT',
]);

export interface EligibilityActionPolicyConfig {
  readonly requiredGates: readonly EligibilityGateCode[];
  readonly precedence: readonly EligibilityGateCode[];
  /** Required iff RISK_POLICY is in requiredGates; forbidden otherwise. */
  readonly riskAllowedActions?: readonly RiskActionCode[];
}

export interface EligibilityPolicyConfig {
  readonly actions: Readonly<Partial<Record<EligibilityActionType, EligibilityActionPolicyConfig>>>;
}

/**
 * Versioned Eligibility policy metadata + optional parsed config.
 * policyConfig is null when the DB column is NULL (unconfigured / historical).
 */
export interface EligibilityPolicyVersion {
  readonly id: string;
  readonly policyVersion: number;
  readonly status: EligibilityPolicyStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly auditReference: string | null;
  readonly policyConfig: EligibilityPolicyConfig | null;
}

export type ResolvedEligibilityPolicyVersion = EligibilityPolicyVersion & {
  readonly status: 'ACTIVE';
  readonly policyConfig: EligibilityPolicyConfig;
};

interface EligibilityPolicyRow {
  readonly id: string;
  readonly policy_version: number;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly audit_reference: string | null;
  readonly policy_config: unknown;
}

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
  throw new FraudDomainError('ELIGIBILITY_POLICY_CONFIG_INVALID', message, details);
}

function parseGateList(
  path: string,
  raw: unknown,
  options: { readonly requireNonEmpty: boolean },
): EligibilityGateCode[] {
  if (!Array.isArray(raw)) {
    configInvalid(`${path} must be an array`, { path });
  }
  if (options.requireNonEmpty && raw.length === 0) {
    configInvalid(`${path} must be non-empty`, { path });
  }
  const out: EligibilityGateCode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw[i];
    if (typeof code !== 'string' || !GATE_CODE_SET.has(code)) {
      configInvalid(`${path}[${i}] is not an allowed eligibility gate code`, { path, code });
    }
    if (seen.has(code)) {
      configInvalid(`${path} contains duplicate gate code ${code}`, { path, code });
    }
    seen.add(code);
    out.push(code as EligibilityGateCode);
  }
  return out;
}

function parseRiskAllowedActions(
  path: string,
  raw: unknown,
): RiskActionCode[] {
  if (!Array.isArray(raw)) {
    configInvalid(`${path} must be an array`, { path });
  }
  if (raw.length === 0) {
    configInvalid(`${path} must be non-empty`, { path });
  }
  const out: RiskActionCode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw[i];
    if (typeof code !== 'string' || !RISK_ACTION_SET.has(code)) {
      configInvalid(`${path}[${i}] is not an allowlisted risk action code`, { path, code });
    }
    if (seen.has(code)) {
      configInvalid(`${path} contains duplicate risk action code ${code}`, { path, code });
    }
    seen.add(code);
    out.push(code as RiskActionCode);
  }
  return out;
}

/**
 * Strict parser for versioned Eligibility action policy configuration.
 * Does not invent defaults, repair malformed input, or define business thresholds.
 */
export function parseEligibilityPolicyConfig(raw: unknown): EligibilityPolicyConfig {
  if (raw === null || raw === undefined) {
    configInvalid('policy_config is missing');
  }
  if (!isPlainJsonObject(raw)) {
    configInvalid('policy_config must be a plain JSON object');
  }

  const keys = Object.keys(raw);
  if (keys.length === 0) {
    configInvalid('policy_config root is empty');
  }
  for (const key of keys) {
    if (key !== 'actions') {
      configInvalid(`unknown policy_config root field ${key}`, { key });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'actions')) {
    configInvalid('policy_config.actions is required');
  }

  const actionsRaw = raw.actions;
  if (!isPlainJsonObject(actionsRaw)) {
    configInvalid('policy_config.actions must be a plain JSON object');
  }

  const actionKeys = Object.keys(actionsRaw);
  if (actionKeys.length === 0) {
    configInvalid('policy_config.actions must configure at least one action');
  }

  const actions: Partial<Record<EligibilityActionType, EligibilityActionPolicyConfig>> = {};

  for (const actionKey of actionKeys) {
    if (!ACTION_TYPE_SET.has(actionKey)) {
      configInvalid(`unknown eligibility action ${actionKey}`, { actionKey });
    }
    const actionCfg = actionsRaw[actionKey];
    if (!isPlainJsonObject(actionCfg)) {
      configInvalid(`policy_config.actions.${actionKey} must be a plain JSON object`, {
        actionKey,
      });
    }
    for (const nestedKey of Object.keys(actionCfg)) {
      if (
        nestedKey !== 'requiredGates' &&
        nestedKey !== 'precedence' &&
        nestedKey !== 'riskAllowedActions'
      ) {
        configInvalid(
          `unknown field ${nestedKey} on policy_config.actions.${actionKey}`,
          { actionKey, nestedKey },
        );
      }
    }
    if (!Object.prototype.hasOwnProperty.call(actionCfg, 'requiredGates')) {
      configInvalid(`policy_config.actions.${actionKey}.requiredGates is required`, {
        actionKey,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(actionCfg, 'precedence')) {
      configInvalid(`policy_config.actions.${actionKey}.precedence is required`, { actionKey });
    }

    const requiredGates = parseGateList(
      `policy_config.actions.${actionKey}.requiredGates`,
      actionCfg.requiredGates,
      { requireNonEmpty: true },
    );
    const precedence = parseGateList(
      `policy_config.actions.${actionKey}.precedence`,
      actionCfg.precedence,
      { requireNonEmpty: true },
    );

    if (precedence.length !== requiredGates.length) {
      configInvalid(
        `policy_config.actions.${actionKey}.precedence must contain exactly the requiredGates set`,
        { actionKey, requiredGates, precedence },
      );
    }
    const requiredSet = new Set(requiredGates);
    for (const code of precedence) {
      if (!requiredSet.has(code)) {
        configInvalid(
          `policy_config.actions.${actionKey}.precedence contains gate ${code} not in requiredGates`,
          { actionKey, code },
        );
      }
    }
    for (const code of requiredGates) {
      if (!precedence.includes(code)) {
        configInvalid(
          `policy_config.actions.${actionKey}.precedence is missing required gate ${code}`,
          { actionKey, code },
        );
      }
    }

    const requiresRiskPolicy = requiredGates.includes('RISK_POLICY');
    const hasRiskAllowedActions = Object.prototype.hasOwnProperty.call(
      actionCfg,
      'riskAllowedActions',
    );

    if (requiresRiskPolicy && !hasRiskAllowedActions) {
      configInvalid(
        `policy_config.actions.${actionKey}.riskAllowedActions is required when RISK_POLICY is required`,
        { actionKey },
      );
    }
    if (!requiresRiskPolicy && hasRiskAllowedActions) {
      configInvalid(
        `policy_config.actions.${actionKey}.riskAllowedActions is forbidden when RISK_POLICY is not required`,
        { actionKey },
      );
    }

    const riskAllowedActions = requiresRiskPolicy
      ? Object.freeze(
          parseRiskAllowedActions(
            `policy_config.actions.${actionKey}.riskAllowedActions`,
            actionCfg.riskAllowedActions,
          ),
        )
      : undefined;

    actions[actionKey as EligibilityActionType] = Object.freeze({
      requiredGates: Object.freeze([...requiredGates]),
      precedence: Object.freeze([...precedence]),
      ...(riskAllowedActions !== undefined ? { riskAllowedActions } : {}),
    });
  }

  return deepFreeze({ actions: Object.freeze({ ...actions }) });
}

function mapRow(row: EligibilityPolicyRow): EligibilityPolicyVersion {
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'SUPERSEDED' &&
    row.status !== 'REVOKED'
  ) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_INTEGRITY',
      `invalid eligibility policy status ${row.status}`,
    );
  }

  let policyConfig: EligibilityPolicyConfig | null = null;
  if (row.policy_config !== null && row.policy_config !== undefined) {
    policyConfig = parseEligibilityPolicyConfig(row.policy_config);
  }

  return {
    id: row.id,
    policyVersion: row.policy_version,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    auditReference: row.audit_reference,
    policyConfig,
  };
}

const POLICY_SELECT = `SELECT id, policy_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference, policy_config`;

/**
 * Resolve the single ACTIVE Eligibility policy applicable at `at` (default server now).
 * Fail closed when zero/multiple rows match or ACTIVE config is missing/unusable.
 */
export async function resolveActiveEligibilityPolicyVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedEligibilityPolicyVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<EligibilityPolicyRow>(
    `${POLICY_SELECT}
     FROM eligibility_policy_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY policy_version ASC`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_NOT_CONFIGURED',
      'No ACTIVE eligibility policy version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_INTEGRITY',
      'Multiple ACTIVE eligibility policy versions apply at the same instant',
      {
        at: at.toISOString(),
        policyVersions: result.rows.map((row) => row.policy_version),
      },
    );
  }

  const row = result.rows[0]!;
  if (row.policy_config === null || row.policy_config === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'ACTIVE eligibility policy has NULL policy_config',
      { policyVersion: row.policy_version },
    );
  }

  const mapped = mapRow(row);
  if (mapped.status !== 'ACTIVE' || mapped.policyConfig === null) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'Resolved ACTIVE eligibility policy has unusable policy_config',
      { policyVersion: mapped.policyVersion },
    );
  }
  return mapped as ResolvedEligibilityPolicyVersion;
}

/**
 * Authoritative ACTIVE Eligibility-policy resolution for evaluateAndPersistEligibility.
 *
 * Uses server current time only (no caller `at`). Selects the matching ACTIVE
 * row with FOR SHARE so policy_config remains stable through the caller's
 * transaction until decision persistence completes.
 *
 * Historical unlocked lookup remains resolveActiveEligibilityPolicyVersion(client, { at }).
 */
export async function resolveActiveEligibilityPolicyVersionForEvaluation(
  client: PoolClient,
): Promise<ResolvedEligibilityPolicyVersion> {
  const at = new Date();
  const result = await client.query<EligibilityPolicyRow>(
    `${POLICY_SELECT}
     FROM eligibility_policy_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY policy_version ASC
     FOR SHARE`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_NOT_CONFIGURED',
      'No ACTIVE eligibility policy version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_INTEGRITY',
      'Multiple ACTIVE eligibility policy versions apply at the same instant',
      {
        at: at.toISOString(),
        policyVersions: result.rows.map((row) => row.policy_version),
      },
    );
  }

  const row = result.rows[0]!;
  if (row.policy_config === null || row.policy_config === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'ACTIVE eligibility policy has NULL policy_config',
      { policyVersion: row.policy_version },
    );
  }

  const mapped = mapRow(row);
  if (mapped.status !== 'ACTIVE' || mapped.policyConfig === null) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'Resolved ACTIVE eligibility policy has unusable policy_config',
      { policyVersion: mapped.policyVersion },
    );
  }
  return mapped as ResolvedEligibilityPolicyVersion;
}

/** Load a historical Eligibility policy by immutable policy_version number. */
export async function loadEligibilityPolicyVersionByNumber(
  client: PoolClient,
  policyVersion: number,
): Promise<EligibilityPolicyVersion> {
  if (!Number.isInteger(policyVersion) || policyVersion <= 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_DECISION_INVALID',
      'policyVersion must be a positive integer',
      { policyVersion },
    );
  }
  const result = await client.query<EligibilityPolicyRow>(
    `${POLICY_SELECT}
     FROM eligibility_policy_versions
     WHERE policy_version = $1`,
    [policyVersion],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_NOT_FOUND',
      `eligibility policy version ${policyVersion} not found`,
      { policyVersion },
    );
  }
  return mapRow(row);
}
