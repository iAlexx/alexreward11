import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';

export type EligibilityPolicyStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

/**
 * Versioned Eligibility policy metadata only.
 * No business rules, country authority, provider caps, or membership bypasses.
 */
export interface EligibilityPolicyVersion {
  readonly id: string;
  readonly policyVersion: number;
  readonly status: EligibilityPolicyStatus;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly reason: string | null;
  readonly auditReference: string | null;
}

export type ResolvedEligibilityPolicyVersion = EligibilityPolicyVersion & {
  readonly status: 'ACTIVE';
};

interface EligibilityPolicyRow {
  readonly id: string;
  readonly policy_version: number;
  readonly status: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly reason: string | null;
  readonly audit_reference: string | null;
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
  return {
    id: row.id,
    policyVersion: row.policy_version,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    reason: row.reason,
    auditReference: row.audit_reference,
  };
}

/**
 * Resolve the single ACTIVE Eligibility policy applicable at `at` (default server now).
 * Fail closed when zero or multiple rows match — never invent policy or fall back.
 */
export async function resolveActiveEligibilityPolicyVersion(
  client: PoolClient,
  options?: { readonly at?: Date },
): Promise<ResolvedEligibilityPolicyVersion> {
  const at = options?.at ?? new Date();
  const result = await client.query<EligibilityPolicyRow>(
    `SELECT id, policy_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference
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

  const mapped = mapRow(result.rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_INTEGRITY',
      'Resolved eligibility policy is not ACTIVE',
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
    `SELECT id, policy_version, status::text AS status,
            effective_from, effective_to, reason, audit_reference
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
