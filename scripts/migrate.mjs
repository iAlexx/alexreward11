#!/usr/bin/env node
/**
 * Apply ordered explicit SQL migrations from migrations/*.sql.
 * Each migration is transactional and records itself in schema_migrations.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'migrations');

// `pg` is owned by the @alex-rewards/db workspace, not the repository root, so it is
// resolved from that package rather than added as a second root dependency.
const pg = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');

function usage() {
  console.error('Usage: node scripts/migrate.mjs [--database-url <url>]');
  process.exit(1);
}

function parseArgs(argv) {
  let databaseUrl = process.env.DATABASE_URL || null;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--database-url') {
      databaseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    usage();
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (env or --database-url)');
    process.exit(1);
  }
  return { databaseUrl };
}

async function listMigrationFiles() {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  return files.map((name) => ({
    name,
    version: name.replace(/\.sql$/, ''),
    path: join(migrationsDir, name),
  }));
}

async function appliedVersions(client) {
  const exists = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (!exists.rows[0].present) return new Set();
  const result = await client.query(`SELECT version FROM schema_migrations`);
  return new Set(result.rows.map((row) => row.version));
}

async function main() {
  const { databaseUrl } = parseArgs(process.argv);
  const migrations = await listMigrationFiles();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const applied = await appliedVersions(client);
    let appliedNow = 0;
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        console.log(`skip  ${migration.name}`);
        continue;
      }
      const sql = await readFile(migration.path, 'utf8');
      console.log(`apply ${migration.name}`);
      await client.query(sql);
      appliedNow += 1;
    }
    const finalApplied = await appliedVersions(client);
    console.log(
      JSON.stringify(
        {
          ok: true,
          totalMigrations: migrations.length,
          previouslyApplied: applied.size,
          appliedNow,
          appliedTotal: finalApplied.size,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('FAIL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
