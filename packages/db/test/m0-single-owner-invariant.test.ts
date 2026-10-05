/**
 * M0 — single-OWNER authority invariant (migration 0025) + independent-review remediations.
 *
 * Destructive migrate against an explicitly nominated disposable test DB only.
 * Requires: M0_DATABASE_URL or PHASE2_DATABASE_URL pointing at alex_rewards_test
 * (or another approved *_test / *_phaseN name). Never alex_rewards /
 * alex_rewards_recovery_dryrun. Do not trust inherited DATABASE_URL alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  listMigrationFiles,
  migrateDatabase,
} from '../src/index.js';

const explicitUrl = process.env.M0_DATABASE_URL ?? process.env.PHASE2_DATABASE_URL ?? '';
const databaseUrl = explicitUrl.trim();

if (process.env.M1_CI_SECURITY_GATE === '1' && databaseUrl === '') {
  throw new Error(
    'M0 suite: M1_CI_SECURITY_GATE=1 requires M0_DATABASE_URL or PHASE2_DATABASE_URL (fail-closed)',
  );
}
const FORBIDDEN_DB_NAMES = new Set(['alex_rewards', 'alex_rewards_recovery_dryrun']);
const migrationsDirectory = fileURLToPath(new URL('../../../migrations/', import.meta.url));

function dbNameFromUrl(url: string): string {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

async function assertIsolatedTarget(url: string): Promise<string> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const name = dbNameFromUrl(url);
  if (FORBIDDEN_DB_NAMES.has(name)) {
    throw new Error(`REFUSE: forbidden database name ${name}`);
  }
  return name;
}

async function dropPublicSchema(url: string): Promise<void> {
  const expected = await assertIsolatedTarget(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    const live = await client.query<{ current_database: string }>(`SELECT current_database()`);
    const current = live.rows[0]?.current_database ?? '';
    if (FORBIDDEN_DB_NAMES.has(current)) {
      throw new Error(`REFUSE: connected to forbidden database ${current}`);
    }
    if (current !== expected) {
      throw new Error(`REFUSE: current_database ${current} != URL database ${expected}`);
    }
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
}

async function resetAndMigrate(url: string): Promise<void> {
  await dropPublicSchema(url);
  await migrateDatabase(url);
}

/** Apply migrations in order while version <= maxVersion (filename without .sql). */
async function migrateThrough(url: string, maxVersion: string): Promise<void> {
  await dropPublicSchema(url);
  const files = await listMigrationFiles(migrationsDirectory);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    for (const migration of files) {
      if (migration.version > maxVersion) break;
      const sql = readFileSync(migration.path, 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

async function applySqlFile(client: Client | Pool | PoolClient, fileName: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, fileName), 'utf8');
  await client.query(sql);
}

async function applySqlFileExpectFail(
  client: Client,
  fileName: string,
  pattern: RegExp,
): Promise<void> {
  await expect(applySqlFile(client, fileName)).rejects.toThrow(pattern);
  // Migration files wrap work in BEGIN/COMMIT; a raised error aborts the session
  // transaction until ROLLBACK is issued on this connection.
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

async function ownerRoleId(db: Pool | Client | PoolClient): Promise<string> {
  const r = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM admin_roles WHERE code = 'OWNER'`,
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('OWNER role missing');
  return id;
}

async function insertAdmin(db: Pool | Client | PoolClient, email: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ($1, $2, 'ACTIVE')
     RETURNING id::text AS id`,
    [email, email],
  );
  return r.rows[0]!.id;
}

async function assertNo0025Residue(db: Pool | Client): Promise<void> {
  const version = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM schema_migrations
      WHERE version = '0025_single_owner_authority'`,
  );
  expect(version.rows[0]?.c).toBe(0);

  const v24 = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM schema_migrations
      WHERE version = '0024_owner_admin_auth_hardening'`,
  );
  expect(v24.rows[0]?.c).toBe(0);

  const table = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'admin_owner_authority'`,
  );
  expect(table.rows[0]?.c).toBe(0);

  const idx = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'admin_role_bindings_one_unrevoked_owner'`,
  );
  expect(idx.rows[0]?.c).toBe(0);

  const trig = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_trigger tr
      JOIN pg_class c ON c.oid = tr.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'admin_role_bindings'
       AND tr.tgname = 'admin_role_bindings_single_owner_authority'`,
  );
  expect(trig.rows[0]?.c).toBe(0);

  const fn = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'app_enforce_single_owner_authority'`,
  );
  expect(fn.rows[0]?.c).toBe(0);
}

/** Install a definitionally-correct throttle table + trigger (0024 shape). */
async function installCorrectThrottle(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_auth_throttle (
      admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
      failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until      TIMESTAMPTZ NULL,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS admin_auth_throttle_set_updated_at ON admin_auth_throttle
  `);
  await client.query(`
    CREATE TRIGGER admin_auth_throttle_set_updated_at
      BEFORE UPDATE ON admin_auth_throttle
      FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
  `);
}

describe.skipIf(databaseUrl === '')(
  'M0 single-OWNER authority invariant',
  { timeout: 300_000 },
  () => {
    let pool: Pool;
    let expectedDatabase: string;

    beforeAll(async () => {
      expectedDatabase = await assertIsolatedTarget(databaseUrl);
      expect(expectedDatabase).not.toBe('alex_rewards');
      await resetAndMigrate(databaseUrl);
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const live = await pool.query<{ current_database: string }>(`SELECT current_database()`);
      expect(live.rows[0]?.current_database).toBe(expectedDatabase);
      const mig = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM schema_migrations
          WHERE version = '0025_single_owner_authority'`,
      );
      expect(mig.rows[0]?.c).toBe(1);
    }, 300_000);

    afterAll(async () => {
      await pool?.end();
    });

    it('A: zero Owner is allowed before bootstrap (vacant seat)', async () => {
      // Fresh migrate leaves vacant seat; clear any bindings from later tests via dedicated suite order —
      // this suite starts vacant only at beforeAll; re-check structural vacancy after wipe.
      await pool.query(
        `DELETE FROM admin_role_bindings WHERE role_id = (SELECT id FROM admin_roles WHERE code = 'OWNER')`,
      );
      await pool.query(
        `UPDATE admin_owner_authority
            SET holder_admin_user_id = NULL, active_binding_id = NULL, claimed_at = NULL
          WHERE seat = 1`,
      );
      const seat = await pool.query<{
        holder_admin_user_id: string | null;
        active_binding_id: string | null;
      }>(
        `SELECT holder_admin_user_id::text, active_binding_id::text
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows).toHaveLength(1);
      expect(seat.rows[0]?.holder_admin_user_id).toBeNull();
      expect(seat.rows[0]?.active_binding_id).toBeNull();
    });

    it('B: first Owner binding succeeds', async () => {
      const roleId = await ownerRoleId(pool);
      const adminId = await insertAdmin(pool, `m0-owner-a-${Date.now()}@local.test`);
      await pool.query(
        `INSERT INTO admin_role_bindings (admin_user_id, role_id)
         VALUES ($1::uuid, $2::uuid)`,
        [adminId, roleId],
      );
      const seat = await pool.query<{ holder: string; binding: string | null }>(
        `SELECT holder_admin_user_id::text AS holder, active_binding_id::text AS binding
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.holder).toBe(adminId);
      expect(seat.rows[0]?.binding).not.toBeNull();
    });

    it('C: second distinct Owner binding fails', async () => {
      const roleId = await ownerRoleId(pool);
      const adminB = await insertAdmin(pool, `m0-owner-b-${Date.now()}@local.test`);
      await expect(
        pool.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id)
           VALUES ($1::uuid, $2::uuid)`,
          [adminB, roleId],
        ),
      ).rejects.toThrow(/single-OWNER invariant|informal transfer|duplicate key|unique/i);
      const unrevoked = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM admin_role_bindings b
           JOIN admin_roles r ON r.id = b.role_id
          WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
      );
      expect(unrevoked.rows[0]?.c).toBe(1);
    });

    it('D: concurrent attempts on two connections — exactly one winner matches seat', async () => {
      await pool.query(
        `DELETE FROM admin_role_bindings
          WHERE role_id = (SELECT id FROM admin_roles WHERE code = 'OWNER')`,
      );
      await pool.query(
        `UPDATE admin_owner_authority
            SET holder_admin_user_id = NULL, active_binding_id = NULL, claimed_at = NULL
          WHERE seat = 1`,
      );

      const roleId = await ownerRoleId(pool);
      const a = await insertAdmin(pool, `m0-race-a-${Date.now()}@local.test`);
      const b = await insertAdmin(pool, `m0-race-b-${Date.now()}@local.test`);

      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        // Two distinct backends; overlap without holding an open transaction across
        // both awaits (seat FOR UPDATE is released at statement end under autocommit).
        const p1 = c1.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id)
           VALUES ($1::uuid, $2::uuid) RETURNING admin_user_id::text AS admin_user_id`,
          [a, roleId],
        );
        await new Promise((r) => setTimeout(r, 5));
        const p2 = c2.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id)
           VALUES ($1::uuid, $2::uuid) RETURNING admin_user_id::text AS admin_user_id`,
          [b, roleId],
        );

        const settled = await Promise.allSettled([p1, p2]);
        const winners: string[] = [];
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            winners.push(s.value.rows[0]!.admin_user_id);
          }
        }
        expect(winners).toHaveLength(1);

        const seat = await pool.query<{ holder: string; binding_admin: string }>(
          `SELECT o.holder_admin_user_id::text AS holder,
                  b.admin_user_id::text AS binding_admin
             FROM admin_owner_authority o
             JOIN admin_role_bindings b ON b.id = o.active_binding_id
            WHERE o.seat = 1`,
        );
        expect(seat.rows[0]?.holder).toBe(winners[0]);
        expect(seat.rows[0]?.binding_admin).toBe(winners[0]);

        const unrevoked = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c
             FROM admin_role_bindings b
             JOIN admin_roles r ON r.id = b.role_id
            WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
        );
        expect(unrevoked.rows[0]?.c).toBe(1);
      } finally {
        c1.release();
        c2.release();
      }
    });

    it('E: duplicate binding for same admin is defined (UNIQUE + un-revoke OK)', async () => {
      const roleId = await ownerRoleId(pool);
      const holder = await pool.query<{ id: string }>(
        `SELECT holder_admin_user_id::text AS id FROM admin_owner_authority WHERE seat = 1`,
      );
      const adminId = holder.rows[0]?.id;
      expect(adminId).toBeTruthy();

      await expect(
        pool.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id) VALUES ($1::uuid, $2::uuid)`,
          [adminId, roleId],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await pool.query(
        `UPDATE admin_role_bindings SET revoked_at = now()
          WHERE admin_user_id = $1::uuid AND role_id = $2::uuid`,
        [adminId, roleId],
      );
      await pool.query(
        `INSERT INTO admin_role_bindings (admin_user_id, role_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (admin_user_id, role_id) DO UPDATE SET revoked_at = NULL`,
        [adminId, roleId],
      );
      const seat = await pool.query<{ holder: string; binding: string | null }>(
        `SELECT holder_admin_user_id::text AS holder, active_binding_id::text AS binding
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.holder).toBe(adminId);
      expect(seat.rows[0]?.binding).not.toBeNull();
    });

    it('F: revocation does not enable unauthorized transfer', async () => {
      const roleId = await ownerRoleId(pool);
      const holderId = (
        await pool.query<{ id: string }>(
          `SELECT holder_admin_user_id::text AS id FROM admin_owner_authority WHERE seat = 1`,
        )
      ).rows[0]!.id;

      await pool.query(
        `UPDATE admin_role_bindings SET revoked_at = now()
          WHERE admin_user_id = $1::uuid AND role_id = $2::uuid AND revoked_at IS NULL`,
        [holderId, roleId],
      );
      const seatAfterRevoke = await pool.query<{ holder: string | null; binding: string | null }>(
        `SELECT holder_admin_user_id::text AS holder, active_binding_id::text AS binding
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seatAfterRevoke.rows[0]?.holder).toBe(holderId);
      expect(seatAfterRevoke.rows[0]?.binding).toBeNull();

      const other = await insertAdmin(pool, `m0-transfer-${Date.now()}@local.test`);
      await expect(
        pool.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id)
           VALUES ($1::uuid, $2::uuid)`,
          [other, roleId],
        ),
      ).rejects.toThrow(/single-OWNER invariant|informal transfer/i);

      await pool.query(
        `INSERT INTO admin_role_bindings (admin_user_id, role_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (admin_user_id, role_id) DO UPDATE SET revoked_at = NULL`,
        [holderId, roleId],
      );
    });

    it('G: single-Owner auth prerequisite shape remains valid', async () => {
      const row = await pool.query<{ id: string }>(
        `SELECT u.id::text AS id
           FROM admin_users u
           INNER JOIN admin_role_bindings b ON b.admin_user_id = u.id AND b.revoked_at IS NULL
           INNER JOIN admin_roles r ON r.id = b.role_id AND r.code = 'OWNER' AND r.status = 'ACTIVE'
          WHERE u.status = 'ACTIVE'
          LIMIT 1`,
      );
      expect(row.rows).toHaveLength(1);
    });

    it('H: Recovery authorization SQL remains OWNER-only (no CO_OWNER)', async () => {
      const recoveryPath = fileURLToPath(
        new URL('../../withdrawals/src/phase10-canary-signing-recovery.ts', import.meta.url),
      );
      const src = readFileSync(recoveryPath, 'utf8');
      expect(src).toContain(`r.code = 'OWNER'`);
      expect(src.toLowerCase()).not.toContain('co_owner');
    });

    it('K: OWNER→non-OWNER role change refused; other→OWNER + admin_user_id rules', async () => {
      const roleId = await ownerRoleId(pool);
      const finance = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM admin_roles WHERE code = 'FINANCE'`,
      );
      expect(finance.rows[0]?.id).toBeTruthy();
      const financeId = finance.rows[0]!.id;

      const holderId = (
        await pool.query<{ id: string }>(
          `SELECT holder_admin_user_id::text AS id FROM admin_owner_authority WHERE seat = 1`,
        )
      ).rows[0]!.id;

      // OWNER → FINANCE refused
      await expect(
        pool.query(
          `UPDATE admin_role_bindings SET role_id = $1::uuid
            WHERE admin_user_id = $2::uuid AND role_id = $3::uuid`,
          [financeId, holderId, roleId],
        ),
      ).rejects.toThrow(/non-OWNER role is refused|single-OWNER invariant/i);

      // admin_user_id change on OWNER binding refused
      const other = await insertAdmin(pool, `m0-reassign-${Date.now()}@local.test`);
      await expect(
        pool.query(
          `UPDATE admin_role_bindings SET admin_user_id = $1::uuid
            WHERE admin_user_id = $2::uuid AND role_id = $3::uuid`,
          [other, holderId, roleId],
        ),
      ).rejects.toThrow(/admin_user_id on an OWNER binding is refused|single-OWNER invariant/i);

      // other role → OWNER: only allowed if seat vacant or same holder; with occupied seat → refuse
      const agent = await insertAdmin(pool, `m0-finance-promote-${Date.now()}@local.test`);
      await pool.query(
        `INSERT INTO admin_role_bindings (admin_user_id, role_id) VALUES ($1::uuid, $2::uuid)`,
        [agent, financeId],
      );
      await expect(
        pool.query(
          `UPDATE admin_role_bindings SET role_id = $1::uuid
            WHERE admin_user_id = $2::uuid AND role_id = $3::uuid`,
          [roleId, agent, financeId],
        ),
      ).rejects.toThrow(/single-OWNER invariant|informal transfer|unique|duplicate key/i);

      // Revocation + restoration consistency
      await pool.query(
        `UPDATE admin_role_bindings SET revoked_at = now()
          WHERE admin_user_id = $1::uuid AND role_id = $2::uuid AND revoked_at IS NULL`,
        [holderId, roleId],
      );
      let seat = await pool.query<{ holder: string; binding: string | null }>(
        `SELECT holder_admin_user_id::text AS holder, active_binding_id::text AS binding
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.holder).toBe(holderId);
      expect(seat.rows[0]?.binding).toBeNull();

      await pool.query(
        `UPDATE admin_role_bindings SET revoked_at = NULL
          WHERE admin_user_id = $1::uuid AND role_id = $2::uuid`,
        [holderId, roleId],
      );
      seat = await pool.query<{ holder: string; binding: string | null }>(
        `SELECT holder_admin_user_id::text AS holder, active_binding_id::text AS binding
           FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.holder).toBe(holderId);
      expect(seat.rows[0]?.binding).not.toBeNull();

      const bindingRole = await pool.query<{ code: string }>(
        `SELECT r.code::text AS code
           FROM admin_owner_authority o
           JOIN admin_role_bindings b ON b.id = o.active_binding_id
           JOIN admin_roles r ON r.id = b.role_id
          WHERE o.seat = 1`,
      );
      expect(bindingRole.rows[0]?.code).toBe('OWNER');
    });

    it('J: migration 0025 recorded after complete ordered install', async () => {
      const versions = await pool.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version`,
      );
      const list = versions.rows.map((r) => r.version);
      expect(list).toContain('0024_owner_admin_auth_hardening');
      expect(list).toContain('0025_single_owner_authority');
    });
  },
);

describe.skipIf(databaseUrl === '')(
  'M0 migration 0024 bookkeeping prerequisites',
  { timeout: 300_000 },
  () => {
    it('refuses 0025 when 0024 objects are missing (does not mark 0024 applied)', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|will not mark 0024 as applied/i,
        );
        await assertNo0025Residue(client);
        const v24 = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM schema_migrations
            WHERE version = '0024_owner_admin_auth_hardening'`,
        );
        expect(v24.rows[0]?.c).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('refuses 0025 when 0024 is only partially installed', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        // Partial 0024: column only, no throttle table/trigger.
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('A: refuses 0025 when throttle has unrelated PRIMARY KEY and missing admin_user_id', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            id                UUID PRIMARY KEY,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|(admin_user_id UUID NOT NULL|PRIMARY KEY \(admin_user_id\)|FK admin_user_id)/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('B: refuses 0025 when throttle PRIMARY KEY or required constraints are wrong', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        // Wrong PK (surrogate id), no FK to admin_users, no failed_attempts CHECK.
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            id                UUID PRIMARY KEY,
            admin_user_id     UUID NOT NULL,
            failed_attempts   INTEGER NOT NULL DEFAULT 0,
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|(PRIMARY KEY \(admin_user_id\)|FK admin_user_id|failed_attempts CHECK)/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('B2: refuses 0025 when FK confkey is not admin_users.id', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        // Same table, wrong referenced column (not id).
        await client.query(`
          ALTER TABLE admin_users
            ADD COLUMN IF NOT EXISTS m0_alt_uuid UUID
        `);
        await client.query(`UPDATE admin_users SET m0_alt_uuid = id WHERE m0_alt_uuid IS NULL`);
        await client.query(`
          ALTER TABLE admin_users
            ADD CONSTRAINT admin_users_m0_alt_uuid_key UNIQUE (m0_alt_uuid)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY
              REFERENCES admin_users (m0_alt_uuid) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|FK admin_user_id→admin_users\.id/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('C: refuses 0025 when TOTP column type is not BIGINT', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step INTEGER NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await installCorrectThrottle(client);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|totp_last_accepted_step BIGINT NULL/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('C2: refuses 0025 when TOTP CHECK is incorrect (not nonnegative NULL-or->=0)', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        // Wrong polarity / bound: > 0 instead of >= 0 (rejects step 0).
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step > 0)
        `);
        await installCorrectThrottle(client);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|totp_last_accepted_step nonnegative CHECK/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('refuses 0025 when TOTP CHECK is weakened with OR TRUE', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (
                totp_last_accepted_step IS NULL
                OR totp_last_accepted_step >= 0
                OR TRUE
              )
        `);
        await installCorrectThrottle(client);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|totp_last_accepted_step nonnegative CHECK/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('refuses 0025 when failed_attempts CHECK is weakened with OR TRUE', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0
              CHECK (failed_attempts >= 0 OR TRUE),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|failed_attempts CHECK/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('D: refuses 0025 when throttle trigger is disabled or not BEFORE UPDATE→app_set_updated_at', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await installCorrectThrottle(client);
        await client.query(
          `ALTER TABLE admin_auth_throttle DISABLE TRIGGER admin_auth_throttle_set_updated_at`,
        );
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at/i,
        );
        await assertNo0025Residue(client);

        // Rebuild with AFTER UPDATE (wrong timing) instead of BEFORE.
        await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            AFTER UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('D2: refuses 0025 when throttle trigger is ENABLE REPLICA (tgenabled=R)', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await installCorrectThrottle(client);
        await client.query(
          `ALTER TABLE admin_auth_throttle ENABLE REPLICA TRIGGER admin_auth_throttle_set_updated_at`,
        );
        const mode = await client.query<{ tgenabled: string }>(
          `SELECT tgenabled::text AS tgenabled
             FROM pg_trigger tr
             JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'admin_auth_throttle'
              AND tr.tgname = 'admin_auth_throttle_set_updated_at'`,
        );
        expect(mode.rows[0]?.tgenabled).toBe('R');
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at|tgenabled IN \(O,A\)/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('D3: refuses 0025 when throttle trigger invokes the wrong function', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION m0_wrong_updated_at()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $fn$
          BEGIN
            RETURN NEW;
          END
          $fn$
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION m0_wrong_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at|app_set_updated_at/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('D4: refuses 0025 when throttle trigger has WHEN (false)', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW
            WHEN (false)
            EXECUTE FUNCTION app_set_updated_at()
        `);
        const qual = await client.query<{ no_when: boolean }>(
          `SELECT (tr.tgqual IS NULL) AS no_when
             FROM pg_trigger tr
             JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'admin_auth_throttle'
              AND tr.tgname = 'admin_auth_throttle_set_updated_at'`,
        );
        expect(qual.rows[0]?.no_when).toBe(false);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at|unrestricted/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('D5: refuses 0025 when throttle trigger is UPDATE OF updated_at only', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE OF updated_at ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        const attr = await client.query<{ empty_attr: boolean }>(
          `SELECT (tr.tgattr = ''::int2vector) AS empty_attr
             FROM pg_trigger tr
             JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'admin_auth_throttle'
              AND tr.tgname = 'admin_auth_throttle_set_updated_at'`,
        );
        expect(attr.rows[0]?.empty_attr).toBe(false);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|admin_auth_throttle_set_updated_at|unrestricted/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('refuses 0025 when locked_until is incorrectly NOT NULL', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_until      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|locked_until TIMESTAMPTZ NULL/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('E: accepts 0025 when complete 0024 is installed (records 0024 + 0025)', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await applySqlFile(client, '0024_owner_admin_auth_hardening.sql');
        // 0024 file does not record itself — still absent until 0025 verifies + inserts.
        let v24 = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM schema_migrations
            WHERE version = '0024_owner_admin_auth_hardening'`,
        );
        expect(v24.rows[0]?.c).toBe(0);

        // Canonical DEFAULT now() expressions from real 0024 must be exactly 'now()'.
        const defs = await client.query<{ attname: string; def_expr: string }>(
          `SELECT a.attname, pg_get_expr(ad.adbin, ad.adrelid) AS def_expr
             FROM pg_attribute a
             JOIN pg_class t ON t.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            WHERE n.nspname = 'public'
              AND t.relname = 'admin_auth_throttle'
              AND a.attname IN ('window_started_at', 'updated_at')
            ORDER BY a.attname`,
        );
        expect(defs.rows).toEqual([
          { attname: 'updated_at', def_expr: 'now()' },
          { attname: 'window_started_at', def_expr: 'now()' },
        ]);

        await applySqlFile(client, '0025_single_owner_authority.sql');
        v24 = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM schema_migrations
            WHERE version = '0024_owner_admin_auth_hardening'`,
        );
        const v25 = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM schema_migrations
            WHERE version = '0025_single_owner_authority'`,
        );
        expect(v24.rows[0]?.c).toBe(1);
        expect(v25.rows[0]?.c).toBe(1);
        const seat = await client.query(
          `SELECT 1 FROM admin_owner_authority WHERE seat = 1`,
        );
        expect(seat.rows).toHaveLength(1);

        // Catalog assert: FK confkey is specifically admin_users.id
        const fk = await client.query<{ local_cols: string[]; conf_cols: string[] }>(
          `SELECT
             (
               SELECT array_agg(a.attname::text ORDER BY u.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
             ) AS local_cols,
             (
               SELECT array_agg(a.attname::text ORDER BY u.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum
             ) AS conf_cols
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_class ft ON ft.oid = c.confrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_namespace fn ON fn.oid = ft.relnamespace
          WHERE n.nspname = 'public'
            AND t.relname = 'admin_auth_throttle'
            AND c.contype = 'f'
            AND fn.nspname = 'public'
            AND ft.relname = 'admin_users'
            AND c.convalidated`,
        );
        expect(fk.rows).toHaveLength(1);
        expect(fk.rows[0]?.local_cols).toEqual(['admin_user_id']);
        expect(fk.rows[0]?.conf_cols).toEqual(['id']);

        const trig = await client.query<{
          tgenabled: string;
          no_when: boolean;
          empty_attr: boolean;
        }>(
          `SELECT tr.tgenabled::text AS tgenabled,
                  (tr.tgqual IS NULL) AS no_when,
                  (tr.tgattr = ''::int2vector) AS empty_attr
             FROM pg_trigger tr
             JOIN pg_class c ON c.oid = tr.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'admin_auth_throttle'
              AND tr.tgname = 'admin_auth_throttle_set_updated_at'`,
        );
        expect(['O', 'A']).toContain(trig.rows[0]?.tgenabled);
        expect(trig.rows[0]?.no_when).toBe(true);
        expect(trig.rows[0]?.empty_attr).toBe(true);
      } finally {
        await client.end();
      }
    });

    it('refuses 0025 when window_started_at/updated_at defaults are not exactly now()', async () => {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`
          ALTER TABLE admin_credentials
            ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
              CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0)
        `);
        // Altered defaults: CURRENT_TIMESTAMP / now()+0 pass a loose now()% prefix
        // check but must fail exact pg_get_expr = 'now()'.
        await client.query(`
          CREATE TABLE admin_auth_throttle (
            admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
            failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            locked_until      TIMESTAMPTZ NULL,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '0')
          )
        `);
        await client.query(`
          CREATE TRIGGER admin_auth_throttle_set_updated_at
            BEFORE UPDATE ON admin_auth_throttle
            FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()
        `);
        const altered = await client.query<{ attname: string; def_expr: string }>(
          `SELECT a.attname, pg_get_expr(ad.adbin, ad.adrelid) AS def_expr
             FROM pg_attribute a
             JOIN pg_class t ON t.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            WHERE n.nspname = 'public'
              AND t.relname = 'admin_auth_throttle'
              AND a.attname IN ('window_started_at', 'updated_at')
            ORDER BY a.attname`,
        );
        for (const row of altered.rows) {
          expect(row.def_expr).not.toBe('now()');
        }
        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /0024 prerequisites incomplete|(window_started_at|updated_at) TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });

    it('fresh ordered migrateDatabase installs through 0025', async () => {
      await resetAndMigrate(databaseUrl);
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const versions = await client.query<{ version: string }>(
          `SELECT version FROM schema_migrations ORDER BY version`,
        );
        const list = versions.rows.map((r) => r.version);
        expect(list).toContain('0024_owner_admin_auth_hardening');
        expect(list).toContain('0025_single_owner_authority');
      } finally {
        await client.end();
      }
    });
  },
);

describe.skipIf(databaseUrl === '')(
  'M0 real migration 0025 conflict refusal',
  { timeout: 300_000 },
  () => {
    async function prepareThrough0024(): Promise<Client> {
      await migrateThrough(databaseUrl, '0023_attempt_requires_state_init');
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await applySqlFile(client, '0024_owner_admin_auth_hardening.sql');
      return client;
    }

    it('I: actual 0025 SQL fails and rolls back on conflicting unrevoked OWNER bindings', async () => {
      const client = await prepareThrough0024();
      try {
        const roleId = await ownerRoleId(client);
        const a = await insertAdmin(client, `m0-conf-a-${Date.now()}@local.test`);
        const b = await insertAdmin(client, `m0-conf-b-${Date.now()}@local.test`);
        await client.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id) VALUES ($1::uuid, $2::uuid)`,
          [a, roleId],
        );
        await client.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id) VALUES ($1::uuid, $2::uuid)`,
          [b, roleId],
        );

        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /M0 migration refused:.*unrevoked OWNER bindings/i,
        );
        await assertNo0025Residue(client);
        // Conflicting bindings remain (precheck aborted before mutating authority objects).
        const c = await client.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_role_bindings
            WHERE role_id = $1::uuid AND revoked_at IS NULL`,
          [roleId],
        );
        expect(c.rows[0]?.c).toBe(2);
      } finally {
        await client.end();
      }
    });

    it('I2: actual 0025 SQL fails on distinct historical holders even if all revoked', async () => {
      const client = await prepareThrough0024();
      try {
        const roleId = await ownerRoleId(client);
        const a = await insertAdmin(client, `m0-hist-a-${Date.now()}@local.test`);
        const b = await insertAdmin(client, `m0-hist-b-${Date.now()}@local.test`);
        await client.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id, revoked_at)
           VALUES ($1::uuid, $2::uuid, now())`,
          [a, roleId],
        );
        await client.query(
          `INSERT INTO admin_role_bindings (admin_user_id, role_id, revoked_at)
           VALUES ($1::uuid, $2::uuid, now())`,
          [b, roleId],
        );

        await applySqlFileExpectFail(
          client,
          '0025_single_owner_authority.sql',
          /M0 migration refused:.*distinct admin_user_id/i,
        );
        await assertNo0025Residue(client);
      } finally {
        await client.end();
      }
    });
  },
);
