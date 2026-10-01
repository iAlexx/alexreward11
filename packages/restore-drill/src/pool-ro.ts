/**
 * Restore-drill-owned PostgreSQL pool with session default_transaction_read_only=on.
 * Never uses @alex-rewards/db createDatabasePool (writable application pool).
 */

import { Pool } from 'pg';

import { RestoreTargetGuardError } from './target-guard.js';

export const RESTORE_DRILL_APPLICATION_NAME = 'alex-rewards-restore-drill' as const;

export function createRestoreDrillReadOnlyPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: RESTORE_DRILL_APPLICATION_NAME,
    options: '-c default_transaction_read_only=on',
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
}

function settingIsOn(value: string | undefined | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'on';
}

/** Verify the connected session is read-only. Fail-closed for production path. */
export async function assertSessionReadOnlyEnforced(pool: Pool): Promise<true> {
  try {
    const result = await pool.query<{ default_ro: string; tx_ro: string }>(
      `SELECT
         current_setting('default_transaction_read_only') AS default_ro,
         current_setting('transaction_read_only') AS tx_ro`,
    );
    const row = result.rows[0];
    if (!settingIsOn(row?.default_ro) && !settingIsOn(row?.tx_ro)) {
      throw new RestoreTargetGuardError(
        'READ_ONLY_NOT_ENFORCED',
        'restore-drill pool is not in PostgreSQL read-only mode',
      );
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof RestoreTargetGuardError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RestoreTargetGuardError(
      'READ_ONLY_NOT_ENFORCED',
      `failed to verify PostgreSQL read-only mode: ${message}`,
    );
  }
}