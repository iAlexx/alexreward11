/**
 * Fail-closed guard for destructive test reset/migrate.
 *
 * Operational local application DB name `alex_rewards` must never be wiped by
 * PHASE*_TESTS=1 + DATABASE_URL fallback. CI uses `alex_rewards_phase2`; local
 * destructive suites must use a dedicated `*_test` / `*_phaseN` database via
 * explicit PHASE*_DATABASE_URL.
 *
 * Database names are resolved with the same `pg-connection-string` parser that
 * the installed `pg` package uses. Ambiguous query overrides (`database` /
 * `dbname` / `db`) are refused — we never silently prefer the URL path.
 * After connect, callers must also assert `current_database()` before DROP /
 * TRUNCATE.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const OPERATIONAL_DATABASE_NAMES = new Set(['alex_rewards']);
const DATABASE_OVERRIDE_QUERY_KEYS = ['database', 'dbname', 'db'] as const;

type PgConnectionStringParse = (connectionString: string) => Record<string, unknown>;

export type DestructiveTestQueryable = {
  query: (sql: string) => PromiseLike<{ rows: ReadonlyArray<Record<string, unknown>> }>;
};

function loadPgConnectionStringParse(): PgConnectionStringParse {
  const require = createRequire(import.meta.url);
  const pgEntry = require.resolve('pg');
  const parserModule = require(
    require.resolve('pg-connection-string', {
      paths: [dirname(pgEntry)],
    }),
  ) as PgConnectionStringParse & { parse?: PgConnectionStringParse };
  const parse = typeof parserModule.parse === 'function' ? parserModule.parse : parserModule;
  if (typeof parse !== 'function') {
    throw new Error('REFUSE: unable to load pg-connection-string parse from installed pg');
  }
  return parse;
}

const parsePgConnectionString = loadPgConnectionStringParse();

function normalizeDatabaseName(value: string): string {
  return value.trim().toLowerCase();
}

function assertNonEmptyDatabaseName(databaseName: string, source: string): string {
  const trimmed = databaseName.trim();
  if (trimmed === '') {
    throw new Error(`REFUSE: destructive test ${source} is missing a database name`);
  }
  return trimmed;
}

export function isApprovedDestructiveTestDatabaseName(databaseName: string): boolean {
  const normalized = normalizeDatabaseName(databaseName);
  if (normalized === '' || OPERATIONAL_DATABASE_NAMES.has(normalized)) {
    return false;
  }
  return normalized.endsWith('_test') || /_phase\d+(_|$)/.test(normalized);
}

function assertApprovedDestructiveTestDatabaseName(databaseName: string, source: string): void {
  const trimmed = assertNonEmptyDatabaseName(databaseName, source);
  const normalized = normalizeDatabaseName(trimmed);
  if (OPERATIONAL_DATABASE_NAMES.has(normalized)) {
    throw new Error(
      'REFUSE: destructive reset/migrate targeting operational database "alex_rewards". ' +
        'Point PHASE*_DATABASE_URL at a dedicated test database (name ending with _test, ' +
        'or CI alex_rewards_phaseN) and do not reuse DATABASE_URL for destructive suites.',
    );
  }
  if (!isApprovedDestructiveTestDatabaseName(trimmed)) {
    throw new Error(
      `REFUSE: destructive test database name "${trimmed}" from ${source} is not approved ` +
        '(require ending _test or containing _phaseN).',
    );
  }
}

function pathDatabaseFromPostgresUrl(connectionString: string): string | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol) && url.protocol !== 'socket:') {
    return null;
  }
  if (url.protocol === 'socket:') {
    return null;
  }
  const pathName = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] ?? '').trim();
  return pathName === '' ? null : pathName;
}

function databaseQueryOverridesFromPostgresUrl(connectionString: string): string[] {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const key of DATABASE_OVERRIDE_QUERY_KEYS) {
    for (const raw of url.searchParams.getAll(key)) {
      const trimmed = raw.trim();
      if (trimmed !== '') values.push(trimmed);
    }
  }
  return values;
}

function uniqueNormalizedNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const normalized = normalizeDatabaseName(name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(name.trim());
  }
  return out;
}

/**
 * Resolve the database name using installed `pg` connection-string semantics,
 * while refusing ambiguous / conflicting database query overrides.
 */
export function databaseNameFromConnectionString(connectionString: string): string {
  const trimmed = connectionString.trim();
  if (trimmed === '') {
    throw new Error('destructive test database URL is empty');
  }

  const pathDatabase = pathDatabaseFromPostgresUrl(trimmed);
  const queryOverrides = databaseQueryOverridesFromPostgresUrl(trimmed);
  const distinctOverrides = uniqueNormalizedNames(queryOverrides);

  if (distinctOverrides.length > 1) {
    throw new Error(
      'REFUSE: destructive test database URL has conflicting database query overrides ' +
        `(${distinctOverrides.join(', ')}).`,
    );
  }

  if (pathDatabase !== null && distinctOverrides.length === 1) {
    const override = distinctOverrides[0]!;
    if (normalizeDatabaseName(pathDatabase) !== normalizeDatabaseName(override)) {
      throw new Error(
        `REFUSE: destructive test database URL path ("${pathDatabase}") conflicts with ` +
          `query override ("${override}"). Do not silently prefer the path.`,
      );
    }
  }

  if (pathDatabase === null && distinctOverrides.length === 1) {
    // Explicit query-only database selection (no path) — still must be approved later.
    return assertNonEmptyDatabaseName(distinctOverrides[0]!, 'URL query');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parsePgConnectionString(trimmed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`destructive test database URL is invalid: ${message}`, {
      cause: error,
    });
  }

  // Extra keys left by pg-connection-string (e.g. dbname=) must not disagree with database=.
  const parsedCandidates = uniqueNormalizedNames(
    DATABASE_OVERRIDE_QUERY_KEYS.map((key) => parsed[key])
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim()),
  );
  if (parsedCandidates.length > 1) {
    throw new Error(
      'REFUSE: destructive test database URL parsed with conflicting database fields ' +
        `(${parsedCandidates.join(', ')}).`,
    );
  }

  const fromParser = parsed.database;
  if (typeof fromParser !== 'string' || fromParser.trim() === '') {
    throw new Error('REFUSE: destructive test database URL is missing a database name');
  }

  // Guard against parser edge cases that treat non-URL blobs as a database name.
  if (/\s/.test(fromParser) || fromParser.includes('=')) {
    throw new Error(
      'REFUSE: destructive test database URL is malformed or not a postgres URL with a clear database name',
    );
  }

  return assertNonEmptyDatabaseName(fromParser, 'pg connection string');
}

/**
 * Refuse DROP SCHEMA / resetAndMigrate against the operational app database.
 * Call immediately before connecting for a destructive schema reset.
 */
export function assertSafeDestructiveTestDatabaseUrl(connectionString: string): void {
  const databaseName = databaseNameFromConnectionString(connectionString);
  assertApprovedDestructiveTestDatabaseName(databaseName, 'URL');
}

/**
 * Second-line guard: on an already-connected client/pool, require
 * `current_database()` to be an approved test database (never `alex_rewards`).
 * Call immediately before DROP SCHEMA / TRUNCATE / other destructive SQL.
 */
export async function assertConnectedDestructiveTestDatabase(
  queryable: DestructiveTestQueryable,
): Promise<string> {
  const result = await queryable.query('SELECT current_database() AS current_database');
  const raw = result.rows[0]?.current_database;
  if (typeof raw !== 'string') {
    throw new Error('REFUSE: current_database() did not return a database name');
  }
  const databaseName = assertNonEmptyDatabaseName(raw, 'current_database()');
  assertApprovedDestructiveTestDatabaseName(databaseName, 'current_database()');
  return databaseName;
}
