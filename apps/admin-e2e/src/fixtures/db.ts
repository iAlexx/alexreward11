import { Client, Pool } from 'pg';

import {
  beginOwnerAdminTotpEnrollment,
  completeOwnerAdminTotpEnrollment,
  generateTotpCode,
} from '@alex-rewards/auth';
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';

import {
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
  PHASE13_ADMIN_E2E_FLAG,
  resolvePhase13DatabaseUrlFromEnv,
} from '../env.js';
import { defaultPublicSeed, writePublicSeed, writeSecrets } from './seed-meta.js';

export function requirePhase13AdminE2eEnabled(): void {
  if (process.env[PHASE13_ADMIN_E2E_FLAG] !== '1') {
    throw new Error('REFUSE: Phase 13 Admin browser E2E requires PHASE13_ADMIN_E2E=1');
  }
}

export function resolvePhase13DatabaseUrl(): string {
  return resolvePhase13DatabaseUrlFromEnv();
}

function dbNameFromUrl(url: string): string {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) {
    throw new Error(`REFUSE: unsafe database identifier "${ident}"`);
  }
  return `"${ident.replaceAll('"', '""')}"`;
}

async function ensureDatabaseExists(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const parsed = new URL(url);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
  if (dbName === '') throw new Error('PHASE13 database URL missing database name');

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [dbName],
    );
    if (existing.rows[0]?.exists !== true) {
      await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    }
  } finally {
    await client.end();
  }
}

export async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

async function ensureOwnerAdmin(pool: Pool): Promise<{ id: string; email: string }> {
  const email = E2E_OWNER_EMAIL;
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM admin_users WHERE email = $1`,
    [email],
  );
  let id = existing.rows[0]?.id;
  if (id === undefined) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Owner Phase13 E2E', 'ACTIVE')
       RETURNING id::text`,
      [email],
    );
    id = inserted.rows[0]?.id;
  }
  if (id === undefined) throw new Error('admin insert failed');
  const role = await pool.query<{ id: string }>(`SELECT id FROM admin_roles WHERE code = 'OWNER'`);
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error('OWNER role missing');
  await pool.query(`UPDATE admin_roles SET status = 'ACTIVE' WHERE id = $1::uuid`, [roleId]);
  await pool.query(
    `INSERT INTO admin_role_bindings (admin_user_id, role_id)
     VALUES ($1::uuid, $2::uuid)
     ON CONFLICT (admin_user_id, role_id) DO UPDATE SET revoked_at = NULL`,
    [id, roleId],
  );
  return { id, email };
}

/**
 * Age reauthenticated_at so assertRecentReauth fails without waiting 15 minutes.
 */
export async function staleAdminSessionReauth(databaseUrl: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `UPDATE admin_sessions
       SET reauthenticated_at = now() - interval '20 minutes'
       WHERE revoked_at IS NULL`,
    );
  } finally {
    await client.end();
  }
}

export async function preparePhase13AdminE2eDatabase(): Promise<void> {
  requirePhase13AdminE2eEnabled();
  const url = resolvePhase13DatabaseUrl();
  await ensureDatabaseExists(url);
  await resetAndMigrate(url);

  const expectedDatabase = dbNameFromUrl(url);
  const pool = new Pool({
    connectionString: url,
    max: 4,
    options: '-c lock_timeout=8s -c statement_timeout=60s',
  });
  try {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const begun = await beginOwnerAdminTotpEnrollment();
    const code = generateTotpCode(begun.totpSecretBytes, t0);
    await completeOwnerAdminTotpEnrollment(pool, {
      adminUserId: owner.id,
      password: E2E_OWNER_PASSWORD,
      totpSecretBytes: begun.totpSecretBytes,
      totpConfirmationCode: code,
      expectedDatabase,
      evaluationTimeMs: t0,
    });

    writePublicSeed(defaultPublicSeed(owner.id));
    writeSecrets({
      password: E2E_OWNER_PASSWORD,
      totpSecretBase64: Buffer.from(begun.totpSecretBytes).toString('base64'),
    });
  } finally {
    await pool.end();
  }
}
