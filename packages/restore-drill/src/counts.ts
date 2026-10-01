import type { Pool } from 'pg';

import type { CountCapture, DrillSectionStatus } from './types.js';

export const REPRESENTATIVE_COUNT_TABLES = [
  'users',
  'ledger_transactions',
  'ledger_entries',
  'ledger_account_balances',
  'withdrawals',
  'withdrawal_attempts',
  'outbox_events',
  'reconciliation_issues',
  'reward_events',
  'ad_sessions',
] as const;

export async function captureRepresentativeCounts(pool: Pool): Promise<{
  readonly status: DrillSectionStatus;
  readonly restoredCaptureStatus: DrillSectionStatus;
  readonly comparisonStatus: DrillSectionStatus;
  readonly failedTables: readonly string[];
  readonly restoredCapture: CountCapture | null;
}> {
  const tables: Record<string, number> = {};
  const failedTables: string[] = [];

  for (const table of REPRESENTATIVE_COUNT_TABLES) {
    try {
      // Whitelisted table identifiers only — never interpolate untrusted input.
      const sql = `SELECT COUNT(*)::text AS count FROM ${table}`;
      const result = await pool.query<{ count: string }>(sql);
      tables[table] = Number(result.rows[0]?.count ?? 0);
    } catch {
      failedTables.push(table);
    }
  }

  if (failedTables.length > 0) {
    return {
      status: 'FAIL',
      restoredCaptureStatus: 'FAIL',
      comparisonStatus: 'NOT_EXECUTED',
      failedTables,
      restoredCapture: null,
    };
  }

  return {
    status: 'PASS',
    restoredCaptureStatus: 'PASS',
    comparisonStatus: 'NOT_EXECUTED',
    failedTables: [],
    restoredCapture: {
      capturedAt: new Date().toISOString(),
      tables,
    },
  };
}

export function diffCountCaptures(
  source: CountCapture | null,
  restored: CountCapture | null,
): Readonly<Record<string, number>> | null {
  if (source === null || restored === null) return null;
  const diff: Record<string, number> = {};
  const keys = new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)]);
  for (const key of keys) {
    diff[key] = (restored.tables[key] ?? 0) - (source.tables[key] ?? 0);
  }
  return diff;
}
