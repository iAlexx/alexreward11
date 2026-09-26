#!/usr/bin/env node
/**
 * LOCAL / disposable-DB only: set password + CONNECT for alex_rewards_signer.
 * Never run against operational production without Owner approval.
 * Does not store secrets in the repository.
 *
 * Usage:
 *   DATABASE_URL=<admin> SIGNER_DB_PASSWORD=<local-only> node scripts/provision-signer-db-role.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pg = createRequire(join(root, 'packages/db/package.json'))('pg');

function usage() {
  console.error(
    'Usage: DATABASE_URL=<admin-url> SIGNER_DB_PASSWORD=<password> node scripts/provision-signer-db-role.mjs',
  );
  process.exit(1);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const password = process.env.SIGNER_DB_PASSWORD;
  if (!databaseUrl || !password || password.trim().length < 16) {
    usage();
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const db = await client.query(
      `SELECT current_database()::text AS current_database`,
    );
    const dbName = db.rows[0]?.current_database;
    if (!dbName) {
      throw new Error('current_database() empty');
    }
    // Refuse obvious operational names unless explicitly isolated_test / _test.
    if (dbName === 'alex_rewards' && process.env.SIGNER_DB_PROVISION_ALLOW_ALEX_REWARDS !== '1') {
      console.error(
        JSON.stringify({
          ok: false,
          error:
            'Refusing to provision on database alex_rewards without SIGNER_DB_PROVISION_ALLOW_ALEX_REWARDS=1',
          database: dbName,
        }),
      );
      process.exit(2);
    }

    const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'alex_rewards_signer'`);
    if ((role.rowCount ?? 0) === 0) {
      console.error(
        JSON.stringify({
          ok: false,
          error: 'Role alex_rewards_signer missing — apply migration 0027 first',
        }),
      );
      process.exit(3);
    }

    // PASSWORD cannot be a bind parameter in PostgreSQL ALTER ROLE.
    const escaped = password.replace(/'/g, "''");
    await client.query(`ALTER ROLE alex_rewards_signer WITH LOGIN PASSWORD '${escaped}'`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO alex_rewards_signer`);
    await client.query(`GRANT USAGE ON SCHEMA public TO alex_rewards_signer`);
    await client.query(
      `GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer`,
    );
    await client.query(`GRANT alex_rewards_signer_ro TO alex_rewards_signer`);

    console.log(
      JSON.stringify({
        ok: true,
        database: dbName,
        role: 'alex_rewards_signer',
        passwordSet: true,
      }),
    );
  } finally {
    await client.end();
  }
}

function quoteIdent(ident) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Unsafe database identifier: ${ident}`);
  }
  return `"${ident}"`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
