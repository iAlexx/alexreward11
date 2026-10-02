/**
 * Read-only production Owner-bootstrap schema / migration preflight (Step 4A.1).
 * Does not apply migrations.
 */
import type { PoolClient } from 'pg';

import { AuthDomainError } from '../errors.js';

/** Exact migrations required for first-Owner bootstrap (names without .sql). */
export const REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS = [
  '0024_owner_admin_auth_hardening',
  '0025_single_owner_authority',
  '0026_owner_bootstrap_grants',
  '0028_owner_bootstrap_attempt_nonce_attempt_wide',
] as const;

export interface ProductionOwnerBootstrapSchemaPreflightResult {
  readonly schemaReady: boolean;
  readonly requiredMigrationsPresent: boolean;
  readonly missingMigrations: readonly string[];
  readonly appliedMigrationNames: readonly string[];
  readonly duplicateNoncePreflightApplicable: boolean;
  readonly duplicateNonceRows: number;
  readonly refuseCode: string | null;
}

export async function preflightProductionOwnerBootstrapSchema(
  client: PoolClient,
): Promise<ProductionOwnerBootstrapSchemaPreflightResult> {
  let applied: string[] = [];
  try {
    const res = await client.query<{ name: string }>(
      `SELECT name FROM schema_migrations ORDER BY name`,
    );
    applied = res.rows.map((r) => r.name.replace(/\.sql$/i, ''));
  } catch {
    return {
      schemaReady: false,
      requiredMigrationsPresent: false,
      missingMigrations: [...REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS],
      appliedMigrationNames: [],
      duplicateNoncePreflightApplicable: false,
      duplicateNonceRows: 0,
      refuseCode: 'SCHEMA_MIGRATIONS_TABLE_UNAVAILABLE',
    };
  }

  const appliedSet = new Set(applied);
  const missing = REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS.filter((m) => !appliedSet.has(m));
  const requiredPresent = missing.length === 0;

  let duplicateNonceRows = 0;
  let duplicateApplicable = false;
  if (requiredPresent) {
    duplicateApplicable = true;
    try {
      const dup = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM (
           SELECT attempt_id, purpose, nonce_hex
           FROM owner_bootstrap_attempt_nonces
           GROUP BY attempt_id, purpose, nonce_hex
           HAVING count(*) > 1
         ) d`,
      );
      duplicateNonceRows = dup.rows[0]?.c ?? 0;
    } catch {
      return {
        schemaReady: false,
        requiredMigrationsPresent: requiredPresent,
        missingMigrations: missing,
        appliedMigrationNames: applied,
        duplicateNoncePreflightApplicable: true,
        duplicateNonceRows: 0,
        refuseCode: 'DUPLICATE_NONCE_PREFLIGHT_QUERY_FAILED',
      };
    }
  }

  const schemaReady = requiredPresent && duplicateNonceRows === 0;
  return {
    schemaReady,
    requiredMigrationsPresent: requiredPresent,
    missingMigrations: missing,
    appliedMigrationNames: applied,
    duplicateNoncePreflightApplicable: duplicateApplicable,
    duplicateNonceRows,
    refuseCode: schemaReady
      ? null
      : missing.length > 0
        ? 'REQUIRED_BOOTSTRAP_MIGRATIONS_MISSING'
        : 'DUPLICATE_NONCE_ROWS_PRESENT',
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
