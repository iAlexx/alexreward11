import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';

export type TrustRuleStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

/**
 * Versioned Trust rule metadata only.
 * No scoring thresholds/weights — Trust policy remains OWNER_DECISION_REQUIRED
 * until a later approved Trust evaluator step (spec §156K).
 */
export interface TrustRuleVersion {
  readonly id: string;
  readonly ruleVersion: number;
  readonly status: TrustRuleStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly auditReference: string | null;
}

export type ResolvedTrustRuleVersion = TrustRuleVersion & {
  readonly status: 'ACTIVE';
};

interface TrustRuleRow {
  readonly id: string;
  readonly rule_version: number;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly audit_reference: string | null;
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
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    auditReference: row.audit_reference,
  };
}

/**
 * Resolve the single ACTIVE Trust rule applicable at `at` (default server now).
 * Fail closed when zero or multiple rows match — never invent Trust policy,
 * never fall back to Risk rules or users table trust columns.
 */
export async function resolveActiveTrustRuleVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedTrustRuleVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<TrustRuleRow>(
    `SELECT id, rule_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference
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

  const mapped = mapRow(result.rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new FraudDomainError('TRUST_RULE_INTEGRITY', 'Resolved trust rule is not ACTIVE');
  }
  return mapped as ResolvedTrustRuleVersion;
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
    `SELECT id, rule_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference
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
