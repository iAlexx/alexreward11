import type { Pool } from 'pg';
import { listMigrationFiles } from '@alex-rewards/db';

import type { DrillSectionStatus } from './types.js';

const CRITICAL_TABLES = [
  'schema_migrations',
  'users',
  'ledger_transactions',
  'ledger_entries',
  'ledger_account_balances',
  'withdrawals',
  'withdrawal_attempts',
  'outbox_events',
  'feature_flags',
  'reconciliation_issues',
  'reward_events',
  'ad_sessions',
] as const;

export interface SchemaValidationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly expectedMigrationCount: number;
  readonly appliedMigrationCount: number;
  readonly missingVersions: readonly string[];
  readonly criticalTablesMissing: readonly string[];
}

export async function validateRestoredSchema(pool: Pool): Promise<SchemaValidationResult> {
  const expected = await listMigrationFiles();
  const expectedVersions = expected.map((m) => m.version);

  const bookkeeping = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (bookkeeping.rows[0]?.present !== true) {
    return {
      status: 'FAIL',
      reasonCode: 'SCHEMA_MIGRATIONS_ABSENT',
      expectedMigrationCount: expectedVersions.length,
      appliedMigrationCount: 0,
      missingVersions: expectedVersions,
      criticalTablesMissing: [...CRITICAL_TABLES],
    };
  }

  const applied = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`);
  const appliedSet = new Set(applied.rows.map((r) => r.version));
  const missingVersions = expectedVersions.filter((v) => !appliedSet.has(v));

  const missingTables: string[] = [];
  for (const table of CRITICAL_TABLES) {
    const check = await pool.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${table}`],
    );
    if (check.rows[0]?.present !== true) missingTables.push(table);
  }

  if (missingVersions.length > 0 || missingTables.length > 0) {
    return {
      status: 'FAIL',
      reasonCode: missingTables.length > 0 ? 'CRITICAL_TABLES_MISSING' : 'MIGRATIONS_MISSING',
      expectedMigrationCount: expectedVersions.length,
      appliedMigrationCount: appliedSet.size,
      missingVersions,
      criticalTablesMissing: missingTables,
    };
  }

  return {
    status: 'PASS',
    reasonCode: 'SCHEMA_COMPATIBLE',
    expectedMigrationCount: expectedVersions.length,
    appliedMigrationCount: appliedSet.size,
    missingVersions: [],
    criticalTablesMissing: [],
  };
}
