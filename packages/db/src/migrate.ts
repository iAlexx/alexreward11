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

/**
 * Apply every pending `migrations/NNNN_*.sql` file in ascending order.
 *
 * Each file is transactional and records its own version in `schema_migrations`,
 * so applying an already-migrated database is a no-op. Migrations are
 * forward-only: there are no down migrations.
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
    const before = await readAppliedVersions(client);
    const appliedNow: string[] = [];
    for (const migration of migrations) {
      if (before.has(migration.version)) continue;
      const sql = await readFile(migration.path, 'utf8');
      await client.query(sql);
      appliedNow.push(migration.version);
    }
    const after = await readAppliedVersions(client);
    return {
      totalMigrations: migrations.length,
      previouslyApplied: before.size,
      appliedNow,
      appliedTotal: after.size,
    };
  } finally {
    await client.end();
  }
}
