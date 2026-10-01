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

const CRITICAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ledger_entries: ['ledger_transaction_id', 'ledger_account_id', 'direction', 'amount_atomic'],
  ledger_account_balances: [
    'ledger_account_id',
    'balance_atomic',
    'version',
    'last_ledger_transaction_id',
  ],
  withdrawals: [
    'state',
    'workflow_id',
    'reservation_ledger_tx_id',
    'settlement_ledger_tx_id',
    'release_ledger_tx_id',
  ],
  withdrawal_attempts: [
    'withdrawal_id',
    'broadcast_result_state',
    'broadcast_submitted_at',
    'broadcast_ambiguity_class',
  ],
  outbox_events: ['event_type', 'dedupe_key', 'aggregate_id', 'payload', 'status'],
  feature_flags: ['flag_key', 'environment', 'enabled'],
  reconciliation_issues: ['severity', 'status'],
};

const CRITICAL_ENUM_LABELS: Readonly<Record<string, readonly string[]>> = {
  outbox_event_status: ['PENDING', 'DISPATCHED', 'FAILED', 'DEAD_LETTER'],
  reconciliation_issue_severity: ['INFO', 'WARNING', 'CRITICAL'],
  reconciliation_issue_status: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'],
};

export interface SchemaValidationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly expectedMigrationCount: number;
  readonly appliedMigrationCount: number;
  readonly missingVersions: readonly string[];
  readonly criticalTablesMissing: readonly string[];
  readonly criticalColumnsMissing: readonly string[];
  readonly criticalEnumValuesMissing: readonly string[];
}

function failResult(
  partial: Omit<
    SchemaValidationResult,
    'criticalColumnsMissing' | 'criticalEnumValuesMissing'
  > &
    Partial<
      Pick<SchemaValidationResult, 'criticalColumnsMissing' | 'criticalEnumValuesMissing'>
    >,
): SchemaValidationResult {
  return {
    ...partial,
    criticalColumnsMissing: partial.criticalColumnsMissing ?? [],
    criticalEnumValuesMissing: partial.criticalEnumValuesMissing ?? [],
  };
}

export async function validateRestoredSchema(pool: Pool): Promise<SchemaValidationResult> {
  const expected = await listMigrationFiles();
  const expectedVersions = expected.map((m) => m.version);

  const bookkeeping = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (bookkeeping.rows[0]?.present !== true) {
    return failResult({
      status: 'FAIL',
      reasonCode: 'SCHEMA_MIGRATIONS_ABSENT',
      expectedMigrationCount: expectedVersions.length,
      appliedMigrationCount: 0,
      missingVersions: expectedVersions,
      criticalTablesMissing: [...CRITICAL_TABLES],
    });
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
    return failResult({
      status: 'FAIL',
      reasonCode: missingTables.length > 0 ? 'CRITICAL_TABLES_MISSING' : 'MIGRATIONS_MISSING',
      expectedMigrationCount: expectedVersions.length,
      appliedMigrationCount: appliedSet.size,
      missingVersions,
      criticalTablesMissing: missingTables,
    });
  }

  const criticalColumnsMissing: string[] = [];
  for (const [table, columns] of Object.entries(CRITICAL_COLUMNS)) {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1`,
      [table],
    );
    const present = new Set(result.rows.map((r) => r.column_name));
    for (const column of columns) {
      if (!present.has(column)) {
        criticalColumnsMissing.push(`${table}.${column}`);
      }
    }
  }

  const criticalEnumValuesMissing: string[] = [];
  for (const [enumName, labels] of Object.entries(CRITICAL_ENUM_LABELS)) {
    const result = await pool.query<{ enumlabel: string }>(
      `SELECT e.enumlabel
         FROM pg_type t
         INNER JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = $1`,
      [enumName],
    );
    const present = new Set(result.rows.map((r) => r.enumlabel));
    for (const label of labels) {
      if (!present.has(label)) {
        criticalEnumValuesMissing.push(`${enumName}.${label}`);
      }
    }
  }

  if (criticalColumnsMissing.length > 0 || criticalEnumValuesMissing.length > 0) {
    return failResult({
      status: 'FAIL',
      reasonCode:
        criticalColumnsMissing.length > 0 ? 'CRITICAL_COLUMNS_MISSING' : 'CRITICAL_ENUM_VALUES_MISSING',
      expectedMigrationCount: expectedVersions.length,
      appliedMigrationCount: appliedSet.size,
      missingVersions: [],
      criticalTablesMissing: [],
      criticalColumnsMissing,
      criticalEnumValuesMissing,
    });
  }

  return {
    status: 'PASS',
    reasonCode: 'SCHEMA_COMPATIBLE',
    expectedMigrationCount: expectedVersions.length,
    appliedMigrationCount: appliedSet.size,
    missingVersions: [],
    criticalTablesMissing: [],
    criticalColumnsMissing: [],
    criticalEnumValuesMissing: [],
  };
}
