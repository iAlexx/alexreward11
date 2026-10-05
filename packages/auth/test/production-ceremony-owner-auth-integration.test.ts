/**
 * Disposable integration coverage for verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool.
 * Never targets operational railway / alex_rewards. Never uses real Owner credentials.
 */
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  ADMIN_TOTP_PERIOD_SECONDS,
  AuthDomainError,
  OWNER_ADMIN_AUTH_MAX_FAILURES,
  beginOwnerAdminTotpEnrollment,
  completeOwnerAdminTotpEnrollment,
  generateTotpCode,
  verifyOwnerAdminPasswordAndTotp,
  verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool,
} from '../src/index.js';
import { registerVerifiedProductionOwnerBootstrapPoolForTests } from '../src/owner-bootstrap/test-only/verified-production-pool-test-hooks.js';

const explicitUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.PHASE3_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const optedInUrl =
  process.env.OWNER_ADMIN_AUTH_TESTS === '1' || process.env.OWNER_BOOTSTRAP_TESTS === '1'
    ? (process.env.DATABASE_URL ?? '')
    : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const describeDb = databaseUrl === '' ? describe.skip : describe;

const PASSWORD = 'Owner-Test-Password-12';
const BAD_PASSWORD = 'Owner-Test-Password-99';
const PERIOD_MS = ADMIN_TOTP_PERIOD_SECONDS * 1000;

function dbNameFromUrl(url: string): string {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

async function resetSchema(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    const live = await client.query<{ current_database: string }>(`SELECT current_database()`);
    const name = live.rows[0]?.current_database ?? '';
    if (name === 'alex_rewards' || name === 'railway') {
      throw new Error('REFUSE: refuse to reset operational database');
    }
    if (name !== dbNameFromUrl(url)) {
      throw new Error(`REFUSE: current_database ${name} != URL database`);
    }
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

async function ensureOwnerAdmin(pool: Pool): Promise<{ id: string; email: string }> {
  const email = 'owner-prod-ceremony@local.test';
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM admin_users WHERE email = $1`,
    [email],
  );
  let id = existing.rows[0]?.id;
  if (id === undefined) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Owner Prod Ceremony', 'ACTIVE')
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

async function enrollFresh(
  pool: Pool,
  adminUserId: string,
  expectedDatabase: string,
  t0 = Date.now(),
) {
  const begun = await beginOwnerAdminTotpEnrollment();
  const code = generateTotpCode(begun.totpSecretBytes, t0);
  await completeOwnerAdminTotpEnrollment(pool, {
    adminUserId,
    password: PASSWORD,
    totpSecretBytes: begun.totpSecretBytes,
    totpConfirmationCode: code,
    expectedDatabase,
    evaluationTimeMs: t0,
  });
  return { totpSecretBytes: begun.totpSecretBytes, enrolledAtMs: t0 };
}

function nextPeriod(atMs: number): number {
  return atMs + PERIOD_MS;
}

describeDb('production ceremony Owner auth integration (Step 4C.2)', () => {
  // Argon2 enrollment + production ceremony path needs headroom on CI/local Windows.
  let pool: Pool;
  let dbName: string;
  let systemIdentifier: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    process.env.DEPLOYMENT_ENV = 'production';
    await resetSchema(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: '-c lock_timeout=8s -c statement_timeout=60s',
    });
    const db = await pool.query<{ name: string }>(`SELECT current_database() AS name`);
    dbName = db.rows[0]!.name;
    const sid = await pool.query<{ s: string }>(
      `SELECT system_identifier::text AS s FROM pg_control_system()`,
    );
    systemIdentifier = sid.rows[0]!.s;
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    process.env.DEPLOYMENT_ENV = 'production';
    await pool.query(`DELETE FROM admin_sessions`);
    await pool.query(`DELETE FROM admin_credentials`);
    await pool.query(`DELETE FROM admin_auth_throttle`);
    await pool.query(`DELETE FROM admin_role_bindings`);
    await pool.query(
      `UPDATE admin_users SET status = 'ACTIVE'
       WHERE email = 'owner-prod-ceremony@local.test'`,
    );
  }, 60_000);

  function bindVerifiedPool(): void {
    registerVerifiedProductionOwnerBootstrapPoolForTests({
      pool,
      databaseName: dbName,
      systemIdentifier,
    });
  }

  it('1. valid password + current TOTP succeeds on production ceremony path', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('2. wrong password fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: BAD_PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('3. wrong TOTP fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: '000000',
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('4. same TOTP step replay fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    const code = generateTotpCode(enrolled.totpSecretBytes, t1);
    await verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
      adminUserId: owner.id,
      password: PASSWORD,
      totpCode: code,
      expectedDatabase: dbName,
      expectedClusterSystemIdentifier: systemIdentifier,
      evaluationTimeMs: t1,
    });
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: code,
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('5-7. throttle increments; lockout preserved; success clears failures', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    for (let i = 0; i < OWNER_ADMIN_AUTH_MAX_FAILURES; i += 1) {
      await expect(
        verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
          adminUserId: owner.id,
          password: BAD_PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase: dbName,
          expectedClusterSystemIdentifier: systemIdentifier,
          evaluationTimeMs: t1,
        }),
      ).rejects.toBeInstanceOf(AuthDomainError);
    }
    const locked = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
      [owner.id],
    );
    expect(locked.rows[0]?.failed_attempts).toBeGreaterThanOrEqual(OWNER_ADMIN_AUTH_MAX_FAILURES);
    expect(locked.rows[0]?.locked_until).not.toBeNull();

    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);

    await pool.query(
      `UPDATE admin_auth_throttle
       SET failed_attempts = 1, locked_until = NULL, window_started_at = now()
       WHERE admin_user_id = $1::uuid`,
      [owner.id],
    );
    const t2 = nextPeriod(t1);
    await verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
      adminUserId: owner.id,
      password: PASSWORD,
      totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
      expectedDatabase: dbName,
      expectedClusterSystemIdentifier: systemIdentifier,
      evaluationTimeMs: t2,
    });
    const cleared = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
      [owner.id],
    );
    expect(cleared.rows[0]?.failed_attempts ?? 0).toBe(0);
    expect(cleared.rows[0]?.locked_until).toBeNull();
  }, 60_000);

  it('8. duplicate/ambiguous credentials fail closed', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    await pool.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, label, password_verifier, status
       ) VALUES ($1::uuid, 'PASSWORD', 'duplicate-pwd', 'duplicate-verifier', 'ACTIVE')`,
      [owner.id],
    );
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('9. inactive Owner fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    await pool.query(`UPDATE admin_users SET status = 'DISABLED' WHERE id = $1::uuid`, [owner.id]);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('10. missing OWNER binding fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    await pool.query(
      `UPDATE admin_role_bindings SET revoked_at = now() WHERE admin_user_id = $1::uuid`,
      [owner.id],
    );
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: systemIdentifier,
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('11. wrong system_identifier fails', async () => {
    const owner = await ensureOwnerAdmin(pool);
    const t0 = Date.now();
    const enrolled = await enrollFresh(pool, owner.id, dbName, t0);
    bindVerifiedPool();
    const t1 = nextPeriod(t0);
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: owner.id,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase: dbName,
        expectedClusterSystemIdentifier: '9999999999999999999',
        evaluationTimeMs: t1,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);

  it('12. arbitrary/unverified pool fails; generic path still refuses operational names', async () => {
    const bare = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await expect(
        verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(bare, {
          adminUserId: '11111111-1111-4111-8111-111111111111',
          password: PASSWORD,
          totpCode: '123456',
          expectedDatabase: dbName,
          expectedClusterSystemIdentifier: systemIdentifier,
        }),
      ).rejects.toBeInstanceOf(AuthDomainError);
    } finally {
      await bare.end();
    }

    await expect(
      verifyOwnerAdminPasswordAndTotp(pool, {
        adminUserId: '11111111-1111-4111-8111-111111111111',
        password: PASSWORD,
        totpCode: '123456',
        expectedDatabase: 'railway',
        expectedClusterSystemIdentifier: systemIdentifier,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  }, 60_000);
});
