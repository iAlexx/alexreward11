/**
 * Fail-closed guard for destructive test reset/migrate.
 *
 * Operational local application DB name `alex_rewards` must never be wiped by
 * PHASE*_TESTS=1 + DATABASE_URL fallback. CI uses `alex_rewards_phase2`; local
 * destructive suites must use a dedicated `*_test` / `*_phaseN` database via
 * explicit PHASE*_DATABASE_URL.
 */

const OPERATIONAL_DATABASE_NAMES = new Set(['alex_rewards']);

export function databaseNameFromConnectionString(connectionString: string): string {
  const trimmed = connectionString.trim();
  if (trimmed === '') {
    throw new Error('destructive test database URL is empty');
  }
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`destructive test database URL is invalid: ${message}`, {
      cause: error,
    });
  }
  const name = decodeURIComponent(pathname.replace(/^\/+/, '').split('/')[0] ?? '').trim();
  if (name === '') {
    throw new Error('destructive test database URL is missing a database name');
  }
  return name;
}

export function isApprovedDestructiveTestDatabaseName(databaseName: string): boolean {
  const normalized = databaseName.trim().toLowerCase();
  if (normalized === '' || OPERATIONAL_DATABASE_NAMES.has(normalized)) {
    return false;
  }
  return normalized.endsWith('_test') || /_phase\d+(_|$)/.test(normalized);
}

/**
 * Refuse DROP SCHEMA / resetAndMigrate against the operational app database.
 * Call immediately before any destructive schema reset.
 */
export function assertSafeDestructiveTestDatabaseUrl(connectionString: string): void {
  const databaseName = databaseNameFromConnectionString(connectionString);
  const normalized = databaseName.toLowerCase();
  if (OPERATIONAL_DATABASE_NAMES.has(normalized)) {
    throw new Error(
      'REFUSE: destructive reset/migrate targeting operational database "alex_rewards". ' +
        'Point PHASE*_DATABASE_URL at a dedicated test database (name ending with _test, ' +
        'or CI alex_rewards_phaseN) and do not reuse DATABASE_URL for destructive suites.',
    );
  }
  if (!isApprovedDestructiveTestDatabaseName(databaseName)) {
    throw new Error(
      `REFUSE: destructive test database name "${databaseName}" is not approved ` +
        '(require ending _test or containing _phaseN).',
    );
  }
}
