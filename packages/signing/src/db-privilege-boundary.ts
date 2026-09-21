/**
 * Fail-closed signer DB privilege boundary (S-05).
 * Rejects superuser / creatable / writable financial-table sessions.
 */
import type { Pool } from 'pg';

import { SignerError } from './errors.js';

const FINANCIAL_TABLES = [
  'withdrawals',
  'withdrawal_attempts',
  'ledger_entries',
  'ledger_transactions',
  'ledger_account_balances',
  'outbox_events',
  'hot_wallets',
] as const;

export interface SignerDbPrivilegeSnapshot {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly isSuperuser: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateDb: boolean;
  readonly inheritsSignerRo: boolean;
  readonly canSelectSigningView: boolean;
  readonly writableFinancialTables: readonly string[];
}

/**
 * Inspect the live session. Does not mutate the database.
 */
export async function inspectSignerDatabasePrivileges(
  pool: Pool,
): Promise<SignerDbPrivilegeSnapshot> {
  const identity = await pool.query<{
    current_user: string;
    session_user: string;
    is_superuser: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    inherits_signer_ro: boolean;
  }>(
    `SELECT current_user::text AS current_user,
            session_user::text AS session_user,
            EXISTS (
              SELECT 1 FROM pg_roles r
              WHERE r.rolname = current_user AND r.rolsuper
            ) AS is_superuser,
            EXISTS (
              SELECT 1 FROM pg_roles r
              WHERE r.rolname = current_user AND r.rolcreaterole
            ) AS rolcreaterole,
            EXISTS (
              SELECT 1 FROM pg_roles r
              WHERE r.rolname = current_user AND r.rolcreatedb
            ) AS rolcreatedb,
            pg_has_role(current_user, 'alex_rewards_signer_ro', 'USAGE') AS inherits_signer_ro`,
  );
  const row = identity.rows[0];
  if (row === undefined) {
    throw new SignerError('INTERNAL', 'Failed to inspect signer DB privileges');
  }

  let canSelectSigningView = false;
  try {
    await pool.query(`SELECT 1 FROM signer_withdrawal_attempt_signing_v LIMIT 1`);
    canSelectSigningView = true;
  } catch {
    // denied or missing view → fail closed later
  }

  const writable: string[] = [];
  for (const table of FINANCIAL_TABLES) {
    const priv = await pool.query<{ ok: boolean }>(
      `SELECT has_table_privilege(current_user, ('public.' || $1::text)::regclass, 'INSERT')
            OR has_table_privilege(current_user, ('public.' || $1::text)::regclass, 'UPDATE')
            OR has_table_privilege(current_user, ('public.' || $1::text)::regclass, 'DELETE')
            OR has_table_privilege(current_user, ('public.' || $1::text)::regclass, 'TRUNCATE') AS ok`,
      [table],
    );
    if (priv.rows[0]?.ok === true) {
      writable.push(table);
    }
  }

  return {
    currentUser: row.current_user,
    sessionUser: row.session_user,
    isSuperuser: row.is_superuser,
    canCreateRole: row.rolcreaterole,
    canCreateDb: row.rolcreatedb,
    inheritsSignerRo: row.inherits_signer_ro,
    canSelectSigningView,
    writableFinancialTables: writable,
  };
}

/**
 * Fail closed: signer must use a least-privilege login that can SELECT the signing
 * view and cannot mutate financial tables or escalate.
 */
export async function assertSignerDatabaseReadBoundary(pool: Pool): Promise<void> {
  const snap = await inspectSignerDatabasePrivileges(pool);
  const failures: string[] = [];

  if (snap.isSuperuser) {
    failures.push('session is PostgreSQL superuser');
  }
  if (snap.canCreateRole) {
    failures.push('session has CREATEROLE');
  }
  if (snap.canCreateDb) {
    failures.push('session has CREATEDB');
  }
  if (!snap.canSelectSigningView) {
    failures.push('cannot SELECT signer_withdrawal_attempt_signing_v');
  }
  if (snap.writableFinancialTables.length > 0) {
    failures.push(
      `writable financial tables: ${snap.writableFinancialTables.join(',')}`,
    );
  }
  const schemaCreate = await pool.query<{ ok: boolean }>(
    `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok`,
  );
  if (schemaCreate.rows[0]?.ok === true) {
    failures.push('session has CREATE on schema public');
  }
  // Preferred local/ops login name; also accept any login that inherits the RO role
  // without elevated attributes (tests may use temporary login names).
  if (!snap.inheritsSignerRo && snap.currentUser !== 'alex_rewards_signer') {
    failures.push('session does not inherit alex_rewards_signer_ro');
  }

  if (failures.length > 0) {
    throw new SignerError(
      'CONFIG',
      `Signer database privilege boundary failed: ${failures.join('; ')}`,
      {
        currentUser: snap.currentUser,
        sessionUser: snap.sessionUser,
        failures,
      },
    );
  }
}
