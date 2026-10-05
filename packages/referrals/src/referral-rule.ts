import type { PoolClient } from 'pg';

import { ReferralDomainError } from './errors.js';

export type ReferralRuleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface ReferralRuleVersion {
  readonly id: string;
  readonly ruleVersion: number;
  readonly activationAccountAgeSeconds: number;
  readonly activationValidAdCount: number;
  readonly baseRateBps: number;
  readonly status: ReferralRuleStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly sourceReference: string | null;
}

export type ResolvedReferralRuleVersion = ReferralRuleVersion & {
  readonly status: 'ACTIVE';
};

interface ReferralRuleRow {
  readonly id: string;
  readonly rule_version: number;
  readonly activation_account_age_seconds: number;
  readonly activation_valid_ad_count: number;
  readonly base_rate_bps: number;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly source_reference: string | null;
}

const REFERRAL_RULE_SELECT = `SELECT id, rule_version,
            activation_account_age_seconds, activation_valid_ad_count, base_rate_bps,
            status::text AS status, effective_from, effective_to, reason, source_reference`;

function assertNonNegativeInt(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    throw new ReferralDomainError('REFERRAL_RULE_INVALID', `${label} must be an integer`, {
      label,
      value,
    });
  }
  if (value < 0) {
    throw new ReferralDomainError('REFERRAL_RULE_INVALID', `${label} must be >= 0`, {
      label,
      value,
    });
  }
  return value;
}

function assertBps(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    throw new ReferralDomainError('REFERRAL_RULE_INVALID', `${label} must be an integer`, {
      label,
      value,
    });
  }
  if (value < 0 || value > 10_000) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_INVALID',
      `${label} must be between 0 and 10000`,
      { label, value },
    );
  }
  return value;
}

export function mapReferralRuleRow(row: ReferralRuleRow): ReferralRuleVersion {
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'SUPERSEDED' &&
    row.status !== 'REVOKED'
  ) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_INTEGRITY',
      `invalid referral rule status ${row.status}`,
    );
  }
  if (!Number.isInteger(row.rule_version) || row.rule_version <= 0) {
    throw new ReferralDomainError('REFERRAL_RULE_INVALID', 'rule_version must be a positive integer');
  }
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    activationAccountAgeSeconds: assertNonNegativeInt(
      'activation_account_age_seconds',
      row.activation_account_age_seconds,
    ),
    activationValidAdCount: assertNonNegativeInt(
      'activation_valid_ad_count',
      row.activation_valid_ad_count,
    ),
    baseRateBps: assertBps('base_rate_bps', row.base_rate_bps),
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    sourceReference: row.source_reference,
  };
}

/**
 * Resolve the single ACTIVE referral rule applicable at `at` (default now).
 * Fail closed when zero or multiple rows match — never invent rates.
 */
export async function resolveActiveReferralRuleVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedReferralRuleVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<ReferralRuleRow>(
    `${REFERRAL_RULE_SELECT}
     FROM referral_rule_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY rule_version ASC`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_NOT_CONFIGURED',
      'No ACTIVE referral rule version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_AMBIGUOUS',
      'Multiple ACTIVE referral rule versions apply at the same instant',
      {
        at: at.toISOString(),
        ruleVersions: result.rows.map((row) => row.rule_version),
      },
    );
  }

  const mapped = mapReferralRuleRow(result.rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new ReferralDomainError('REFERRAL_RULE_INTEGRITY', 'Resolved referral rule is not ACTIVE');
  }
  return mapped as ResolvedReferralRuleVersion;
}

/**
 * Authoritative ACTIVE referral-rule resolution for evaluation paths.
 * Uses server current time only (no caller `at`) and locks the row FOR SHARE.
 */
export async function resolveActiveReferralRuleVersionForEvaluation(
  client: PoolClient,
): Promise<ResolvedReferralRuleVersion> {
  const nowResult = await client.query<{ now: Date }>(`SELECT now() AS now`);
  const at = nowResult.rows[0]?.now;
  if (at === undefined) {
    throw new ReferralDomainError('INTERNAL', 'failed to read server now()');
  }

  const result = await client.query<ReferralRuleRow>(
    `${REFERRAL_RULE_SELECT}
     FROM referral_rule_versions
     WHERE status = 'ACTIVE'
       AND effective_from <= $1::timestamptz
       AND (effective_to IS NULL OR $1::timestamptz < effective_to)
     ORDER BY rule_version ASC
     FOR SHARE`,
    [at.toISOString()],
  );

  if (result.rows.length === 0) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_NOT_CONFIGURED',
      'No ACTIVE referral rule version applies at the requested time',
      { at: at.toISOString() },
    );
  }
  if (result.rows.length > 1) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_AMBIGUOUS',
      'Multiple ACTIVE referral rule versions apply at the same instant',
      {
        at: at.toISOString(),
        ruleVersions: result.rows.map((row) => row.rule_version),
      },
    );
  }

  const mapped = mapReferralRuleRow(result.rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new ReferralDomainError('REFERRAL_RULE_INTEGRITY', 'Resolved referral rule is not ACTIVE');
  }
  return mapped as ResolvedReferralRuleVersion;
}

/** Load a historical rule by immutable rule_version number (any status). */
export async function loadReferralRuleVersionByNumber(
  client: PoolClient,
  ruleVersion: number,
): Promise<ReferralRuleVersion> {
  if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_INVALID',
      'ruleVersion must be a positive integer',
    );
  }
  const result = await client.query<ReferralRuleRow>(
    `${REFERRAL_RULE_SELECT}
     FROM referral_rule_versions
     WHERE rule_version = $1`,
    [ruleVersion],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ReferralDomainError(
      'REFERRAL_RULE_NOT_CONFIGURED',
      `referral rule version ${ruleVersion} not found`,
      { ruleVersion },
    );
  }
  return mapReferralRuleRow(row);
}
