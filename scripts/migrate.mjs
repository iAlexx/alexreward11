#!/usr/bin/env node
/**
 * Apply ordered explicit SQL migrations from migrations/*.sql.
 *
 * Delegates to `@alex-rewards/db` migrateDatabase so ledger recording and the
 * Phase 13 legacy marker repair stay in one place.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function loadMigrateDatabase() {
  const require = createRequire(join(root, 'package.json'));
  let resolved;
  try {
    resolved = require.resolve('@alex-rewards/db');
  } catch {
    resolved = join(root, 'packages/db/dist/index.js');
  }
  const mod = await import(pathToFileURL(resolved).href);
  if (typeof mod.migrateDatabase !== 'function') {
    throw new Error('migrateDatabase export missing from @alex-rewards/db — run pnpm --filter @alex-rewards/db build');
  }
  return mod.migrateDatabase;
}

async function main() {
  const { databaseUrl } = parseArgs(process.argv);
  const migrateDatabase = await loadMigrateDatabase();
  const result = await migrateDatabase(databaseUrl);
  for (const version of result.repairedLegacyMarkers) {
    console.log(`repair ${version}`);
  }
  for (const version of result.appliedNow) {
    console.log(`apply ${version}.sql`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        totalMigrations: result.totalMigrations,
        previouslyApplied: result.previouslyApplied,
        appliedNow: result.appliedNow.length,
        appliedTotal: result.appliedTotal,
        repairedLegacyMarkers: result.repairedLegacyMarkers,
      },
      null,
      2,
    ),
  );
  if (result.appliedTotal !== result.totalMigrations) {
    console.error(
      `FAIL: appliedTotal (${result.appliedTotal}) !== totalMigrations (${result.totalMigrations})`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('FAIL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
