/**
 * Read-only production Owner-bootstrap schema / migration preflight (Phase 21 Step 4A.2).
 * Does not apply migrations.
 */
import type { PoolClient } from 'pg';

import { AuthDomainError } from '../errors.js';

/**
 * Exact migration versions required before production first-Owner bootstrap.
 * Includes intermediate 0027 (signer login isolation) because migrations are sequential
 * and 0028 cannot be present without 0027 in this repository.
 */
export const REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS = [
  '0024_owner_admin_auth_hardening',
  '0025_single_owner_authority',
  '0026_owner_bootstrap_grants',
  '0027_signer_login_isolation',
  '0028_owner_bootstrap_attempt_nonce_attempt_wide',
] as const;

export interface ProductionOwnerBootstrapSchemaPreflightResult {
  readonly schemaReady: boolean;
  readonly requiredMigrationsPresent: boolean;
  readonly missingMigrations: readonly string[];
  readonly appliedMigrationVersions: readonly string[];
  readonly migration0028Applied: boolean;
  readonly duplicateNoncePreflightApplicable: boolean;
  readonly duplicateNonceRows: number;
  readonly refuseCode: string | null;
  readonly notes: readonly string[];
}

export async function preflightProductionOwnerBootstrapSchema(
  client: PoolClient,
): Promise<ProductionOwnerBootstrapSchemaPreflightResult> {
  let applied: string[] = [];
  try {
    const res = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    applied = res.rows.map((r) => r.version.replace(/\.sql$/i, ''));
  } catch {
    return {
      schemaReady: false,
      requiredMigrationsPresent: false,
      missingMigrations: [...REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS],
      appliedMigrationVersions: [],
      migration0028Applied: false,
      duplicateNoncePreflightApplicable: false,
      duplicateNonceRows: 0,
      refuseCode: 'SCHEMA_MIGRATIONS_TABLE_UNAVAILABLE',
      notes: ['schema_migrations.version query failed — fail closed'],
    };
  }

  const appliedSet = new Set(applied);
  const missing = REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS.filter((m) => !appliedSet.has(m));
  const requiredPresent = missing.length === 0;
  const migration0028Applied = appliedSet.has('0028_owner_bootstrap_attempt_nonce_attempt_wide');

  let duplicateNonceRows = 0;
  let duplicateApplicable = false;
  const notes: string[] = ['SCHEMA_MIGRATION_COLUMN=version'];

  if (!migration0028Applied) {
    // Pre-0028: same nonce must not appear under multiple purposes for one attempt.
    duplicateApplicable = true;
    try {
      const dup = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM (
           SELECT attempt_id, nonce_hex
           FROM owner_bootstrap_attempt_nonces
           GROUP BY attempt_id, nonce_hex
           HAVING count(*) > 1
         ) d`,
      );
      duplicateNonceRows = dup.rows[0]?.c ?? 0;
      notes.push(
        duplicateNonceRows > 0
          ? 'BLOCK_0028_DUPLICATE_NONCES'
          : '0028_DUPLICATE_PREFLIGHT=PASS',
      );
    } catch {
      return {
        schemaReady: false,
        requiredMigrationsPresent: requiredPresent,
        missingMigrations: missing,
        appliedMigrationVersions: applied,
        migration0028Applied,
        duplicateNoncePreflightApplicable: true,
        duplicateNonceRows: 0,
        refuseCode: 'DUPLICATE_NONCE_PREFLIGHT_QUERY_FAILED',
        notes,
      };
    }
  } else {
    notes.push('0028_ALREADY_APPLIED — cross-purpose duplicate cleanup not applicable');
  }

  const blockedByDupes = !migration0028Applied && duplicateNonceRows > 0;
  const schemaReady = requiredPresent && !blockedByDupes;
  return {
    schemaReady,
    requiredMigrationsPresent: requiredPresent,
    missingMigrations: missing,
    appliedMigrationVersions: applied,
    migration0028Applied,
    duplicateNoncePreflightApplicable: duplicateApplicable,
    duplicateNonceRows,
    refuseCode: schemaReady
      ? null
      : blockedByDupes
        ? 'BLOCK_0028_DUPLICATE_NONCES'
        : missing.length > 0
          ? 'REQUIRED_BOOTSTRAP_MIGRATIONS_MISSING'
          : 'BLOCK_0028_DUPLICATE_NONCES',
    notes,
  };
}

export function assertProductionOwnerBootstrapSchemaReady(
  result: ProductionOwnerBootstrapSchemaPreflightResult,
): void {
  if (!result.schemaReady) {
    throw new AuthDomainError(
      'FORBIDDEN',
      result.refuseCode ?? 'PRODUCTION_OWNER_BOOTSTRAP_SCHEMA_READY=NO',
    );
  }
}
