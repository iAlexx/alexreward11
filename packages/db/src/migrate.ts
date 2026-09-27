import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Repository migration directory, resolved from both `src/` and the built `dist/`
 * output because both sit three levels below the repository root.
 */
export const defaultMigrationsDirectory = fileURLToPath(
  new URL('../../../migrations/', import.meta.url),
);

export interface MigrationFile {
  readonly version: string;
  readonly fileName: string;
  readonly path: string;
}

export interface MigrateDatabaseOptions {
  readonly migrationsDirectory?: string;
}

export interface MigrateDatabaseResult {
  readonly totalMigrations: number;
  readonly previouslyApplied: number;
  readonly appliedNow: readonly string[];
  readonly appliedTotal: number;
  /** Phase 13 ledger markers backfilled after schema verification (not re-executed). */
  readonly repairedLegacyMarkers: readonly string[];
}

export async function listMigrationFiles(
  migrationsDirectory: string = defaultMigrationsDirectory,
): Promise<MigrationFile[]> {
  const fileNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return fileNames.map((fileName) => ({
    fileName,
    version: fileName.replace(/\.sql$/, ''),
    path: join(migrationsDirectory, fileName),
  }));
}

async function readAppliedVersions(client: Client): Promise<Set<string>> {
  const bookkeeping = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (bookkeeping.rows[0]?.present !== true) return new Set<string>();
  const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(applied.rows.map((row) => row.version));
}

async function recordMigrationVersion(client: Client, version: string): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [version],
  );
}

type SchemaPresence = 'absent' | 'complete' | 'partial';

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${tableName}`],
  );
  return result.rows[0]?.present === true;
}

async function columnsPresent(
  client: Client,
  tableName: string,
  requiredColumns: readonly string[],
): Promise<boolean> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = ANY($2::text[])`,
    [tableName, [...requiredColumns]],
  );
  const found = new Set(result.rows.map((row) => row.column_name));
  return requiredColumns.every((column) => found.has(column));
}

async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = $1
     ) AS present`,
    [indexName],
  );
  return result.rows[0]?.present === true;
}

const PHASE13_0031 = '0031_phase13_admin_webauthn_challenges';
const PHASE13_0032 = '0032_phase13_admin_web_confirmations';
const PHASE13_0033 = '0033_phase13_admin_webauthn_session_bind';

async function assessPhase13_0031(client: Client): Promise<SchemaPresence> {
  if (!(await tableExists(client, 'admin_webauthn_challenges'))) return 'absent';
  const columnsOk = await columnsPresent(client, 'admin_webauthn_challenges', [
    'id',
    'admin_user_id',
    'purpose',
    'challenge',
    'expires_at',
    'consumed_at',
    'created_at',
  ]);
  const indexesOk =
    (await indexExists(client, 'admin_webauthn_challenges_admin_active_idx')) &&
    (await indexExists(client, 'admin_webauthn_challenges_expiry_idx'));
  return columnsOk && indexesOk ? 'complete' : 'partial';
}

async function assessPhase13_0032(client: Client): Promise<SchemaPresence> {
  if (!(await tableExists(client, 'admin_web_confirmations'))) return 'absent';
  const columnsOk = await columnsPresent(client, 'admin_web_confirmations', [
    'id',
    'admin_user_id',
    'admin_session_id',
    'action_type',
    'resource_type',
    'resource_id',
    'expected_version',
    'payload_digest',
    'nonce',
    'phrase_hash',
    'issued_at',
    'expires_at',
    'confirmed_at',
    'consumed_at',
  ]);
  const indexesOk =
    (await indexExists(client, 'admin_web_confirmations_session_open_idx')) &&
    (await indexExists(client, 'admin_web_confirmations_admin_open_idx'));
  return columnsOk && indexesOk ? 'complete' : 'partial';
}

async function assessPhase13_0033(client: Client): Promise<SchemaPresence> {
  if (!(await tableExists(client, 'admin_webauthn_challenges'))) return 'absent';
  const columnOk = await columnsPresent(client, 'admin_webauthn_challenges', ['admin_session_id']);
  if (!columnOk) return 'absent';
  const indexOk = await indexExists(client, 'admin_webauthn_challenges_session_active_idx');
  return indexOk ? 'complete' : 'partial';
}

/**
 * Tightly scoped Phase 13 bookkeeping repair for Railway staging DBs where
 * 0031–0033 SQL ran but never recorded `schema_migrations` rows.
 *
 * Fresh databases: no tables → absent → no backfill (migrations run normally).
 * Partial schema: FAIL CLOSED (do not mark applied).
 */
export async function repairPhase13LegacyMigrationMarkers(
  client: Client,
): Promise<readonly string[]> {
  const bookkeeping = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (bookkeeping.rows[0]?.present !== true) return [];

  const applied = await readAppliedVersions(client);
  const repaired: string[] = [];

  const checks: ReadonlyArray<{
    version: string;
    assess: (client: Client) => Promise<SchemaPresence>;
  }> = [
    { version: PHASE13_0031, assess: assessPhase13_0031 },
    { version: PHASE13_0032, assess: assessPhase13_0032 },
    { version: PHASE13_0033, assess: assessPhase13_0033 },
  ];

  for (const check of checks) {
    if (applied.has(check.version)) continue;
    const presence = await check.assess(client);
    if (presence === 'absent') continue;
    if (presence === 'partial') {
      throw new Error(
        `REFUSE: Phase 13 migration ${check.version} schema is partial/inconsistent; ` +
          'cannot backfill schema_migrations marker. Repair the schema manually or restore from a known-good backup.',
      );
    }
    await recordMigrationVersion(client, check.version);
    repaired.push(check.version);
    console.info(
      `[migrate] repaired Phase 13 legacy schema_migrations marker after schema verification: ${check.version}`,
    );
  }

  return repaired;
}

/**
 * Apply every pending `migrations/NNNN_*.sql` file in ascending order.
 *
 * After each successful SQL application the runner records the version in
 * `schema_migrations` with ON CONFLICT DO NOTHING (safe with older migrations
 * that already self-record). Migrations are forward-only: there are no downs.
 *
 * Before applying pending files, a narrowly scoped Phase 13 ledger repair may
 * backfill markers 0031–0033 when their schema is demonstrably complete.
 */
export async function migrateDatabase(
  connectionString: string,
  options: MigrateDatabaseOptions = {},
): Promise<MigrateDatabaseResult> {
  const migrations = await listMigrationFiles(
    options.migrationsDirectory ?? defaultMigrationsDirectory,
  );
  const client = new Client({
    connectionString,
    application_name: 'alex-rewards-migrate',
  });
  await client.connect();
  try {
    const beforeRepair = await readAppliedVersions(client);
    const repairedLegacyMarkers = [...(await repairPhase13LegacyMigrationMarkers(client))];
    const before = await readAppliedVersions(client);
    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (before.has(migration.version)) continue;
      const sql = await readFile(migration.path, 'utf8');
      await client.query(sql);
      // Record only after SQL completes successfully. Harmless if the migration
      // already self-inserted its version (ON CONFLICT DO NOTHING).
      await recordMigrationVersion(client, migration.version);
      appliedNow.push(migration.version);
      before.add(migration.version);
    }
    const after = await readAppliedVersions(client);
    return {
      totalMigrations: migrations.length,
      previouslyApplied: beforeRepair.size,
      appliedNow,
      appliedTotal: after.size,
      repairedLegacyMarkers,
    };
  } finally {
    await client.end();
  }
}
