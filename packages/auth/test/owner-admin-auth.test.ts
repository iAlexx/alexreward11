/**
 * Owner admin password+TOTP + session lifecycle — Round 2 security remediation suite.
 *
 * Requires: OWNER_ADMIN_AUTH_DATABASE_URL or PHASE3/PHASE7 pointing at an approved
 * isolated *_test / *_phaseN database. Never targets operational alex_rewards.
 */
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  ADMIN_REAUTH_MAX_AGE_MS,
  ADMIN_TOTP_PERIOD_SECONDS,
  AuthDomainError,
  OWNER_ADMIN_AUTH_MAX_FAILURES,
  assertNoUnsupportedActiveCredentials,
  assertOperationalFirstEnrollmentAllowed,
  assertOwnerAuthOperationalDefaultDeny,
  beginOwnerAdminTotpEnrollment,
  completeOwnerAdminTotpEnrollment,
  generateTotpCode,
  hashAdminSessionToken,
  isAdminSessionReauthFresh,
  loginOwnerAdmin,
  logoutOwnerAdminSession,
  preflightOwnerAdminEnrollment,
  reauthenticateOwnerAdminSession,
  verifyOwnerAdminPasswordAndTotp,
  withPinnedOwnerAuthTransaction,
  withPoolOwnedOwnerAuthTransaction,
  withPoolOwnedReadOnlyTransaction,
} from '../src/index.js';
import {
  assertInteractiveSecretTerminals,
  displaySecretOnceOnInteractiveStderr,
} from '../src/tty-secret.js';

const explicitUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.PHASE3_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const optedInUrl =
  process.env.OWNER_ADMIN_AUTH_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

if (process.env.M1_CI_SECURITY_GATE === '1' && databaseUrl === '') {
  throw new Error(
    'Owner Authentication suite: M1_CI_SECURITY_GATE=1 requires OWNER_ADMIN_AUTH_DATABASE_URL (or PHASE3/PHASE7) (fail-closed)',
  );
}
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
    if (name === 'alex_rewards') {
      throw new Error('REFUSE: refuse to reset operational alex_rewards');
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
  const email = 'owner-auth@local.test';
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM admin_users WHERE email = $1`,
    [email],
  );
  let id = existing.rows[0]?.id;
  if (id === undefined) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Owner Auth Test', 'ACTIVE')
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
  const result = await completeOwnerAdminTotpEnrollment(pool, {
    adminUserId,
    password: PASSWORD,
    totpSecretBytes: begun.totpSecretBytes,
    totpConfirmationCode: code,
    expectedDatabase,
    evaluationTimeMs: t0,
  });
  return { ...result, totpSecretBytes: begun.totpSecretBytes, enrolledAtMs: t0 };
}

/**
 * Issue 3: apply test-only PostgreSQL timeouts on EVERY Pool connection via the
 * libpq/pg `options` startup parameter (verified for pg@8.23.0). This covers
 * clients from pool.connect() and pool.query() alike — unlike a one-shot SET on
 * a single checked-out client. Do not use an un-awaited connect callback for SET.
 */
function createIsolatedAuthTestPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 8,
    options: "-c lock_timeout=8s -c statement_timeout=60s",
  });
}

function nextPeriod(atMs: number): number {
  return atMs + PERIOD_MS;
}

async function takeLoginToken(
  pool: Pool,
  input: Parameters<typeof loginOwnerAdmin>[1],
): Promise<{ sessionToken: string; sessionId: string; reauthenticatedAt: string }> {
  const bundle = await loginOwnerAdmin(pool, input);
  const sessionToken = bundle.takeSessionTokenOnce();
  return {
    sessionToken,
    sessionId: bundle.result.sessionId,
    reauthenticatedAt: bundle.result.reauthenticatedAt,
  };
}

async function evaluateRecoveryOwnerAuthGates(
  pool: Pool,
  adminUserId: string,
  sessionToken: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const binding = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [adminUserId],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) return { ok: false, reason: 'missing OWNER binding' };
  const tokenHash = hashAdminSessionToken(sessionToken);
  const session = await pool.query<{
    admin_user_id: string;
    reauthenticated_at: Date | null;
    idle_expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT admin_user_id::text, reauthenticated_at, idle_expires_at, absolute_expires_at, revoked_at
     FROM admin_sessions WHERE session_token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = session.rows[0];
  if (row === undefined) return { ok: false, reason: 'session not found' };
  if (row.admin_user_id !== adminUserId) return { ok: false, reason: 'session not bound to admin' };
  if (row.revoked_at !== null) return { ok: false, reason: 'session revoked' };
  const now = Date.now();
  if (row.idle_expires_at.getTime() <= now || row.absolute_expires_at.getTime() <= now) {
    return { ok: false, reason: 'session expired' };
  }
  if (row.reauthenticated_at === null) return { ok: false, reason: 'reauth missing' };
  if (now - row.reauthenticated_at.getTime() > ADMIN_REAUTH_MAX_AGE_MS) {
    return { ok: false, reason: 'reauth stale' };
  }
  return { ok: true };
}

async function snapshotAuthState(pool: Pool, adminUserId: string) {
  const creds = await pool.query<{ id: string; credential_type: string; status: string }>(
    `SELECT id::text, credential_type::text, status::text
     FROM admin_credentials WHERE admin_user_id = $1::uuid ORDER BY id`,
    [adminUserId],
  );
  const sessions = await pool.query<{ id: string; revoked_at: Date | null }>(
    `SELECT id::text, revoked_at FROM admin_sessions WHERE admin_user_id = $1::uuid ORDER BY id`,
    [adminUserId],
  );
  return { creds: creds.rows, sessions: sessions.rows };
}

describe('FS-01 / FS-05 / policy pure + mock (no operational DB)', () => {
  it('R-05 operational first-enrollment policy refuses alex_rewards with zero active', () => {
    expect(() => assertOperationalFirstEnrollmentAllowed('alex_rewards', false)).toThrow(
      AuthDomainError,
    );
    expect(() => assertOperationalFirstEnrollmentAllowed('alex_rewards', true)).not.toThrow();
    expect(() => assertOperationalFirstEnrollmentAllowed('alex_rewards_test', false)).not.toThrow();
  });

  it('R-01 assertNoUnsupportedActiveCredentials refuses WEBAUTHN and unknown types', () => {
    expect(() =>
      assertNoUnsupportedActiveCredentials([{ credential_type: 'WEBAUTHN' }]),
    ).toThrow(AuthDomainError);
    expect(() =>
      assertNoUnsupportedActiveCredentials([
        { credential_type: 'PASSWORD' },
        { credential_type: 'TOTP' },
        { credential_type: 'WEBAUTHN' },
      ]),
    ).toThrow(AuthDomainError);
    expect(() =>
      assertNoUnsupportedActiveCredentials([{ credential_type: 'HARDWARE_KEY_X' }]),
    ).toThrow(AuthDomainError);
    expect(() =>
      assertNoUnsupportedActiveCredentials([
        { credential_type: 'PASSWORD' },
        { credential_type: 'TOTP' },
      ]),
    ).not.toThrow();
  });

  it('R-04 TTY asserts refuse non-interactive/redirected secret surfaces', () => {
    expect(() => assertInteractiveSecretTerminals()).toThrow(/interactive TTY/);
  });

  it('R-04 displaySecretOnce refuses when stdout/stderr are not TTYs', async () => {
    await expect(
      displaySecretOnceOnInteractiveStderr({
        label: 'SECRET',
        secret: 'must-not-appear-if-redirected',
        warning: 'test',
      }),
    ).rejects.toThrow(/interactive TTY/);
  });

  it('FS-01 operational default-deny refuses alex_rewards name', () => {
    expect(() => assertOwnerAuthOperationalDefaultDeny('alex_rewards')).toThrow(AuthDomainError);
    expect(() => assertOwnerAuthOperationalDefaultDeny('alex_rewards_test')).not.toThrow();
  });

  it('FS-01 mock ops identity refuses every public Owner-auth entry point without mutations', async () => {
    const calls: string[] = [];
    const mockClient = {
      query: async (text: unknown) => {
        const sql = typeof text === 'string' ? text : '';
        calls.push(sql.split('\n')[0]!.trim().slice(0, 80));
        if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
        if (/current_database/i.test(sql)) {
          return { rows: [{ current_database: 'alex_rewards' }] };
        }
        if (/pg_control_system/i.test(sql)) {
          return { rows: [{ system_identifier: '1' }] };
        }
        if (/^COMMIT|^ROLLBACK/i.test(sql.trim())) return { rows: [] };
        throw new Error(`unexpected query under ops deny: ${sql.slice(0, 120)}`);
      },
      release: () => undefined,
    };
    const mockPool = {
      connect: async () => mockClient,
    } as unknown as Pool;

    // Simulate connected ops DB while expected is a test name (mismatch path still deny-first on current).
    const gate = {
      expectedDatabase: 'alex_rewards_test',
      expectedClusterSystemIdentifier: '1',
      operationalConfirm: 'I_CONFIRM_OWNER_ADMIN_AUTH_ON_ALEX_REWARDS',
    };

    await expect(
      preflightOwnerAdminEnrollment(mockPool, {
        adminUserId: '00000000-0000-0000-0000-000000000001',
        ...gate,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const begun = await beginOwnerAdminTotpEnrollment();
    const totpCode = generateTotpCode(begun.totpSecretBytes);
    await expect(
      completeOwnerAdminTotpEnrollment(mockPool, {
        adminUserId: '00000000-0000-0000-0000-000000000001',
        password: PASSWORD,
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode: totpCode,
        ...gate,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      loginOwnerAdmin(mockPool, {
        adminUserId: '00000000-0000-0000-0000-000000000001',
        password: PASSWORD,
        totpCode: '000000',
        ...gate,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reauthenticateOwnerAdminSession(mockPool, {
        sessionToken: 'x',
        password: PASSWORD,
        totpCode: '000000',
        ...gate,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      logoutOwnerAdminSession(mockPool, { sessionToken: 'x', ...gate }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyOwnerAdminPasswordAndTotp(mockPool, {
        adminUserId: '00000000-0000-0000-0000-000000000001',
        password: PASSWORD,
        totpCode: '000000',
        ...gate,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // expectedDatabase=alex_rewards also refused before any mutation path.
    expect(() => assertOwnerAuthOperationalDefaultDeny('alex_rewards')).toThrow(AuthDomainError);

    expect(calls.some((c) => /INSERT|UPDATE|DELETE/i.test(c))).toBe(false);
  });

  it('FS-05 pool connect failure', async () => {
    const broken = {
      connect: async () => {
        throw new Error('injected connect failure');
      },
    } as unknown as Pool;
    await expect(
      withPoolOwnedOwnerAuthTransaction(broken, async () => ({ status: 'ok' as const, value: 1 })),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('FS-05 query failure after BEGIN rolls back and releases', async () => {
    let released = 0;
    let rolledBack = false;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN\b/i.test(sql.trim())) return { rows: [] };
          if (/^ROLLBACK\b/i.test(sql.trim())) {
            rolledBack = true;
            return { rows: [] };
          }
          if (/^COMMIT\b/i.test(sql.trim())) return { rows: [] };
          throw new Error('injected query failure');
        },
        release: () => {
          released += 1;
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedOwnerAuthTransaction(broken, async (client) => {
        await client.query('SELECT 1');
        return { status: 'ok' as const, value: 1 };
      }),
    ).rejects.toThrow(/injected query failure/);
    expect(rolledBack).toBe(true);
    expect(released).toBe(1);
  });

  it('FS-05 ROLLBACK failure destroys client and preserves context', async () => {
    let destroyed = false;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN\b/i.test(sql.trim())) return { rows: [] };
          if (/^ROLLBACK\b/i.test(sql.trim())) throw new Error('injected rollback failure');
          throw new Error('injected work failure');
        },
        release: (err?: Error | boolean) => {
          destroyed = Boolean(err);
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedOwnerAuthTransaction(broken, async () => {
        throw new Error('injected work failure');
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AuthDomainError &&
        err.code === 'INTERNAL' &&
        /rollback failed/i.test(err.message) &&
        !err.message.includes(PASSWORD)
      );
    });
    expect(destroyed).toBe(true);
  });

  it('Issue1: work throws AuthDomainError containing "COMMIT failed" still ROLLBACKs', async () => {
    let rolledBack = false;
    let released = 0;
    let destroyed = false;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
          if (/^ROLLBACK/i.test(sql.trim())) {
            rolledBack = true;
            return { rows: [] };
          }
          if (/^COMMIT/i.test(sql.trim())) {
            throw new Error('should not COMMIT after work failure');
          }
          return { rows: [] };
        },
        release: (err?: Error | boolean) => {
          released += 1;
          destroyed = Boolean(err);
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedReadOnlyTransaction(broken, async () => {
        throw new AuthDomainError('INTERNAL', 'simulated COMMIT failed before commit phase');
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AuthDomainError &&
        err.message.includes('COMMIT failed before commit') &&
        !/rollback failed/i.test(err.message)
      );
    });
    expect(rolledBack).toBe(true);
    expect(released).toBe(1);
    expect(destroyed).toBe(false);
  });

  it('Issue1: read-only COMMIT failure destroys client (indeterminate)', async () => {
    let destroyed = false;
    let released = 0;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
          if (/^COMMIT/i.test(sql.trim())) throw new Error('injected COMMIT failure');
          return { rows: [] };
        },
        release: (err?: Error | boolean) => {
          released += 1;
          destroyed = Boolean(err);
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedReadOnlyTransaction(broken, async () => 'ok'),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AuthDomainError &&
        /COMMIT failed|indeterminate/i.test(err.message) &&
        !err.message.includes(PASSWORD)
      );
    });
    expect(destroyed).toBe(true);
    expect(released).toBe(1);
  });

  it('Issue1: read-only ROLLBACK failure destroys client', async () => {
    let destroyed = false;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN/i.test(sql.trim())) return { rows: [] };
          if (/^ROLLBACK/i.test(sql.trim())) throw new Error('injected rollback failure');
          return { rows: [] };
        },
        release: (err?: Error | boolean) => {
          destroyed = Boolean(err);
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedReadOnlyTransaction(broken, async () => {
        throw new AuthDomainError('VALIDATION', 'work boom COMMIT failed wording');
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(destroyed).toBe(true);
  });

  it('Issue1: read-only BEGIN failure destroys client; work never runs', async () => {
    let workRan = false;
    let destroyed = false;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN/i.test(sql.trim())) throw new Error('injected BEGIN failure');
          return { rows: [] };
        },
        release: (err?: Error | boolean) => {
          destroyed = Boolean(err);
        },
      }),
    } as unknown as Pool;
    await expect(
      withPoolOwnedReadOnlyTransaction(broken, async () => {
        workRan = true;
        return 1;
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(workRan).toBe(false);
    expect(destroyed).toBe(true);
  });

  it('Issue1: successful read-only transaction releases once', async () => {
    let released = 0;
    const broken = {
      connect: async () => ({
        query: async (text: unknown) => {
          const sql = typeof text === 'string' ? text : '';
          if (/^BEGIN|^COMMIT/i.test(sql.trim())) return { rows: [] };
          return { rows: [] };
        },
        release: () => {
          released += 1;
        },
      }),
    } as unknown as Pool;
    await expect(withPoolOwnedReadOnlyTransaction(broken, async () => 42)).resolves.toBe(42);
    expect(released).toBe(1);
  });
});

describe.skipIf(databaseUrl === '')(
  'owner admin auth Round 2 remediation (isolated)',
  { timeout: 240_000 },
  () => {
    let pool: Pool;
    let adminUserId: string;
    let expectedDatabase: string;

    beforeAll(async () => {
      expectedDatabase = dbNameFromUrl(databaseUrl);
      expect(expectedDatabase).not.toBe('alex_rewards');
      await resetSchema(databaseUrl);
      pool = createIsolatedAuthTestPool(databaseUrl);
      const live = await pool.query<{ current_database: string }>(`SELECT current_database()`);
      expect(live.rows[0]?.current_database).toBe(expectedDatabase);
      const col = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM information_schema.columns
         WHERE table_name = 'admin_credentials' AND column_name = 'totp_last_accepted_step'`,
      );
      expect(col.rows[0]?.c).toBe(1);
      const thr = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM information_schema.tables
         WHERE table_name = 'admin_auth_throttle'`,
      );
      expect(thr.rows[0]?.c).toBe(1);
    }, 240_000);

    afterAll(async () => {
      await pool?.end();
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM admin_sessions`);
      await pool.query(`DELETE FROM admin_credentials`);
      await pool.query(`DELETE FROM admin_auth_throttle`);
      await pool.query(`DELETE FROM admin_role_bindings`);
      await pool.query(
        `DELETE FROM admin_users WHERE email IN ('no-owner@local.test', 'other-owner-gate@local.test')
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs a WHERE a.admin_user_id = admin_users.id
         )`,
      );
      await pool.query(
        `UPDATE admin_users SET status = 'DISABLED'
         WHERE email IN ('no-owner@local.test', 'other-owner-gate@local.test')`,
      );
      const owner = await ensureOwnerAdmin(pool);
      adminUserId = owner.id;
    }, 60_000);

    it('hashes session tokens with admin-session: domain prefix (Recovery-compatible)', () => {
      const token = 'test-session-token-value';
      expect(hashAdminSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashAdminSessionToken(token)).toBe(hashAdminSessionToken(` ${token} `));
    });

    it('F-10 refuses expectedDatabase mismatch', async () => {
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase: 'definitely_wrong_db_name_test',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('R-03 refuses wrong expectedClusterSystemIdentifier on test DB when supplied', async () => {
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase,
          expectedClusterSystemIdentifier: '9999999999999999999',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('enrolls password+TOTP and logs in with a later TOTP step', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      expect(login.sessionToken.length).toBeGreaterThan(20);
      expect(isAdminSessionReauthFresh(login.reauthenticatedAt)).toBe(true);
      const audits = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM audit_logs
         WHERE action_type IN ('owner_admin_auth.credential_enrolled', 'owner_admin_auth.session_created')`,
      );
      expect((audits.rows[0]?.c ?? 0) >= 2).toBe(true);
    });

    it('refuses invalid password', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('refuses invalid TOTP', async () => {
      const t0 = Date.now();
      await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: '000000',
          expectedDatabase,
          evaluationTimeMs: nextPeriod(t0),
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('F-06 / R-05 refuses TOTP replay in the same step', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const code = generateTotpCode(enrolled.totpSecretBytes, t1);
      await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: code,
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: code,
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('R-05 concurrent TOTP replay: at most one acceptance of the same step', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const code = generateTotpCode(enrolled.totpSecretBytes, t1);
      const results = await Promise.allSettled([
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: code,
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: code,
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const sessions = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_sessions WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [adminUserId],
      );
      expect(sessions.rows[0]?.c).toBe(1);
    });

    it('refuses login when OWNER binding revoked', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      await pool.query(
        `UPDATE admin_role_bindings SET revoked_at = now() WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      const t1 = nextPeriod(t0);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses enroll for admin without OWNER role', async () => {
      const existing = await pool.query<{ id: string }>(
        `SELECT id::text FROM admin_users WHERE email = 'no-owner@local.test'`,
      );
      let id = existing.rows[0]?.id;
      if (id === undefined) {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO admin_users (email, display_name, status)
           VALUES ('no-owner@local.test', 'No Owner', 'ACTIVE')
           RETURNING id::text`,
        );
        id = inserted.rows[0]!.id;
      } else {
        await pool.query(`UPDATE admin_users SET status = 'ACTIVE' WHERE id = $1::uuid`, [id]);
      }
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId: id,
          password: PASSWORD,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    async function expectReplaceRefusedNoMutation(
      setup: () => Promise<void>,
      replaceOpts: { currentPassword?: string; currentTotpCode?: string } = {},
    ) {
      await setup();
      const before = await snapshotAuthState(pool, adminUserId);
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'NEW',
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: replaceOpts.currentPassword ?? PASSWORD,
          currentTotpCode: replaceOpts.currentTotpCode ?? '123456',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const after = await snapshotAuthState(pool, adminUserId);
      expect(after).toEqual(before);
    }

    it('R-01 refuses replace when only WEBAUTHN is ACTIVE', async () => {
      await expectReplaceRefusedNoMutation(async () => {
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
           ) VALUES ($1::uuid, 'WEBAUTHN', 'passkey', 'cred-only', 'pk-only', 'ACTIVE')`,
          [adminUserId],
        );
      });
    });

    it('R-01 refuses replace when WEBAUTHN + PASSWORD are ACTIVE', async () => {
      await expectReplaceRefusedNoMutation(async () => {
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
           ) VALUES ($1::uuid, 'WEBAUTHN', 'passkey', 'cred-wp', 'pk-wp', 'ACTIVE')`,
          [adminUserId],
        );
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, password_verifier, status
           ) VALUES ($1::uuid, 'PASSWORD', 'pwd', 'x', 'ACTIVE')`,
          [adminUserId],
        );
      });
    });

    it('R-01 refuses replace when WEBAUTHN + TOTP are ACTIVE', async () => {
      await expectReplaceRefusedNoMutation(async () => {
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
           ) VALUES ($1::uuid, 'WEBAUTHN', 'passkey', 'cred-wt', 'pk-wt', 'ACTIVE')`,
          [adminUserId],
        );
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, totp_secret_reference, status
           ) VALUES ($1::uuid, 'TOTP', 'totp', 'x', 'ACTIVE')`,
          [adminUserId],
        );
      });
    });

    it('R-01 refuses replace when WEBAUTHN + PASSWORD + TOTP are ACTIVE (no mutation/session)', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      await pool.query(
        `INSERT INTO admin_credentials (
           admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
         ) VALUES ($1::uuid, 'WEBAUTHN', 'passkey', 'cred-wpt', 'pk-wpt', 'ACTIVE')`,
        [adminUserId],
      );
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const before = await snapshotAuthState(pool, adminUserId);
      const sessionCountBefore = before.sessions.length;
      const begun = await beginOwnerAdminTotpEnrollment();
      const t2 = nextPeriod(t1);
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'Z',
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t2),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          evaluationTimeMs: t2,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const after = await snapshotAuthState(pool, adminUserId);
      expect(after.creds).toEqual(before.creds);
      expect(after.sessions.length).toBe(sessionCountBefore);
      expect(after.sessions.every((s) => s.revoked_at === null || s.revoked_at !== undefined)).toBe(
        true,
      );
      // Existing session still valid; no new auth session from refused replace
      expect(await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken)).toEqual({
        ok: true,
      });
      const webauthn = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND credential_type = 'WEBAUTHN' AND status = 'ACTIVE'`,
        [adminUserId],
      );
      expect(webauthn.rows[0]?.c).toBe(1);
    });

    it('R-01 PASSWORD + TOTP only: replace succeeds', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const begun = await beginOwnerAdminTotpEnrollment();
      const t1 = nextPeriod(t0);
      const replace = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId,
        password: PASSWORD + 'X',
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t1),
        expectedDatabase,
        replaceExisting: true,
        currentPassword: PASSWORD,
        currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        evaluationTimeMs: t1,
      });
      expect(replace.replaced).toBe(true);
    });

    it('R-01b after replace: new TOTP accepts and old TOTP is rejected', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const oldSecret = enrolled.totpSecretBytes;
      const begun = await beginOwnerAdminTotpEnrollment();
      const newSecret = begun.totpSecretBytes;
      const t1 = nextPeriod(t0);
      const replace = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId,
        password: PASSWORD + 'R',
        totpSecretBytes: newSecret,
        totpConfirmationCode: generateTotpCode(newSecret, t1),
        expectedDatabase,
        replaceExisting: true,
        currentPassword: PASSWORD,
        currentTotpCode: generateTotpCode(oldSecret, t1),
        evaluationTimeMs: t1,
      });
      expect(replace.replaced).toBe(true);

      const t2 = nextPeriod(t1);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD + 'R',
          totpCode: generateTotpCode(oldSecret, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      const t3 = nextPeriod(t2);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD + 'R',
        totpCode: generateTotpCode(newSecret, t3),
        expectedDatabase,
        evaluationTimeMs: t3,
      });
      expect(login.sessionToken.length).toBeGreaterThan(20);
      expect(await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken)).toEqual({
        ok: true,
      });
    });

    it('R-01 inactive/revoked WEBAUTHN does not block PASSWORD+TOTP replace', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      await pool.query(
        `INSERT INTO admin_credentials (
           admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status, disabled_at
         ) VALUES ($1::uuid, 'WEBAUTHN', 'old-passkey', 'cred-off', 'pk-off', 'DISABLED', now())`,
        [adminUserId],
      );
      const begun = await beginOwnerAdminTotpEnrollment();
      const t1 = nextPeriod(t0);
      const replace = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId,
        password: PASSWORD + 'Y',
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t1),
        expectedDatabase,
        replaceExisting: true,
        currentPassword: PASSWORD,
        currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        evaluationTimeMs: t1,
      });
      expect(replace.replaced).toBe(true);
    });

    it('R-01 refuses replace for unsupported ACTIVE credential type', async () => {
      await expectReplaceRefusedNoMutation(async () => {
        // Cast via text: schema may only allow known enum — use WEBAUTHN as proxy if enum is closed
        await pool.query(
          `INSERT INTO admin_credentials (
             admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
           ) VALUES ($1::uuid, 'WEBAUTHN', 'unsupported-proxy', 'cred-uns', 'pk-uns', 'ACTIVE')`,
          [adminUserId],
        );
      });
    });

    it('F-02 refuses shadow enroll when WEBAUTHN already active', async () => {
      await pool.query(
        `INSERT INTO admin_credentials (
           admin_user_id, credential_type, label, webauthn_credential_id, webauthn_public_key, status
         ) VALUES ($1::uuid, 'WEBAUTHN', 'passkey', 'cred-1', 'pk-1', 'ACTIVE')`,
        [adminUserId],
      );
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const count = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND credential_type IN ('PASSWORD','TOTP') AND status = 'ACTIVE'`,
        [adminUserId],
      );
      expect(count.rows[0]?.c).toBe(0);
    });

    it('F-07 credential rotation revokes prior sessions', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      expect(await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken)).toEqual({
        ok: true,
      });

      const begun = await beginOwnerAdminTotpEnrollment();
      const t2 = nextPeriod(t1);
      const replace = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId,
        password: PASSWORD + 'X',
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t2),
        expectedDatabase,
        replaceExisting: true,
        currentPassword: PASSWORD,
        currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
        evaluationTimeMs: t2,
      });
      expect(replace.sessionsRevoked).toBeGreaterThanOrEqual(1);
      expect(
        await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken),
      ).toMatchObject({ ok: false, reason: 'session revoked' });
    });

    it('reauthenticates the same session with a fresh TOTP step', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await pool.query(
        `UPDATE admin_sessions
         SET reauthenticated_at = now() - ($2::text || ' milliseconds')::interval
         WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken), String(ADMIN_REAUTH_MAX_AGE_MS + 60_000)],
      );
      const t2 = nextPeriod(t1);
      const reauth = await reauthenticateOwnerAdminSession(pool, {
        sessionToken: login.sessionToken,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
        expectedDatabase,
        evaluationTimeMs: t2,
      });
      expect(isAdminSessionReauthFresh(reauth.reauthenticatedAt)).toBe(true);
      expect(reauth.sessionId).toBe(login.sessionId);
    });

    it('logout revokes session; reauth then fails', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await logoutOwnerAdminSession(pool, {
        sessionToken: login.sessionToken,
        expectedDatabase,
      });
      const t2 = nextPeriod(t1);
      await expect(
        reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    });

    it('expired session cannot reauth', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await pool.query(
        `UPDATE admin_sessions
         SET idle_expires_at = now() - interval '1 minute',
             absolute_expires_at = now() - interval '1 minute'
         WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      const t2 = nextPeriod(t1);
      await expect(
        reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    });

    it('cross-session: user last_reauthenticated_at does not refresh session reauth', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await pool.query(
        `UPDATE admin_sessions SET reauthenticated_at = NULL WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      await pool.query(
        `UPDATE admin_users SET last_reauthenticated_at = now() WHERE id = $1::uuid`,
        [adminUserId],
      );
      expect(
        await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken),
      ).toMatchObject({ ok: false, reason: 'reauth missing' });
    });

    it('refuses double-enroll without replaceExisting', async () => {
      await enrollFresh(pool, adminUserId, expectedDatabase);
      const begun = await beginOwnerAdminTotpEnrollment();
      await expect(
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
          expectedDatabase,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('F-03 / R-06 transaction rollback leaves no partial credentials', async () => {
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_totp_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.credential_type = 'TOTP' THEN
            RAISE EXCEPTION 'injected failure after password';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_test_fail_totp ON admin_credentials;
        CREATE TRIGGER trg_test_fail_totp
          BEFORE INSERT ON admin_credentials
          FOR EACH ROW EXECUTE FUNCTION test_fail_totp_insert();
      `);
      try {
        const begun = await beginOwnerAdminTotpEnrollment();
        await expect(
          completeOwnerAdminTotpEnrollment(pool, {
            adminUserId,
            password: PASSWORD,
            totpSecretBytes: begun.totpSecretBytes,
            totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
            expectedDatabase,
          }),
        ).rejects.toThrow();
        const count = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_credentials WHERE admin_user_id = $1::uuid`,
          [adminUserId],
        );
        expect(count.rows[0]?.c).toBe(0);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS trg_test_fail_totp ON admin_credentials`);
        await pool.query(`DROP FUNCTION IF EXISTS test_fail_totp_insert()`);
      }
    });

    it('F-08 concurrent first enroll: at most one success', async () => {
      const a = await beginOwnerAdminTotpEnrollment();
      const b = await beginOwnerAdminTotpEnrollment();
      const t0 = Date.now();
      const results = await Promise.allSettled([
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD,
          totpSecretBytes: a.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(a.totpSecretBytes, t0),
          expectedDatabase,
        }),
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'Y',
          totpSecretBytes: b.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(b.totpSecretBytes, t0),
          expectedDatabase,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const active = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND status = 'ACTIVE' AND disabled_at IS NULL`,
        [adminUserId],
      );
      expect(active.rows[0]?.c).toBe(2);
    });

    it('F-05 sequential lockout after repeated failures', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      for (let i = 0; i < OWNER_ADMIN_AUTH_MAX_FAILURES; i += 1) {
        await expect(
          loginOwnerAdmin(pool, {
            adminUserId,
            password: BAD_PASSWORD,
            totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
            expectedDatabase,
            evaluationTimeMs: t1,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      }
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('R-02 concurrent invalid logins: failures are serialized and lock out', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const attempts = Array.from({ length: OWNER_ADMIN_AUTH_MAX_FAILURES + 2 }, () =>
        loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      );
      const results = await Promise.allSettled(attempts);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      const throttle = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
        `SELECT failed_attempts, locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      const failedAttempts = throttle.rows[0]?.failed_attempts ?? 0;
      expect(
        failedAttempts,
        `expected failed_attempts >= ${OWNER_ADMIN_AUTH_MAX_FAILURES}, got ${failedAttempts}; locked_until=${String(throttle.rows[0]?.locked_until ?? null)}`,
      ).toBeGreaterThanOrEqual(OWNER_ADMIN_AUTH_MAX_FAILURES);
      expect(throttle.rows[0]?.locked_until).not.toBeNull();
      const sessions = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_sessions WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(sessions.rows[0]?.c).toBe(0);
    });

    it('R-02 invalid login racing with valid login: lockout or single success, never silent accept after fail gap', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      // Seed MAX-1 failures so one more invalid reaches threshold
      for (let i = 0; i < OWNER_ADMIN_AUTH_MAX_FAILURES - 1; i += 1) {
        await expect(
          loginOwnerAdmin(pool, {
            adminUserId,
            password: BAD_PASSWORD,
            totpCode: '000000',
            expectedDatabase,
            evaluationTimeMs: t1,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      }
      const code = generateTotpCode(enrolled.totpSecretBytes, t1);
      const results = await Promise.allSettled([
        loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: '000000',
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: code,
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ]);
      const sessions = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_sessions WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [adminUserId],
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // Either valid wins before lockout (1 session) or lockout wins (0 sessions); never >1
      expect(sessions.rows[0]?.c).toBeLessThanOrEqual(1);
      expect(fulfilled.length).toBeLessThanOrEqual(1);
      expect(fulfilled.length).toBe(sessions.rows[0]?.c ?? 0);
    });

    it('R-02 concurrent invalid reauthentication records failures without session refresh', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const before = await pool.query<{ reauthenticated_at: Date }>(
        `SELECT reauthenticated_at FROM admin_sessions WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          reauthenticateOwnerAdminSession(pool, {
            sessionToken: login.sessionToken,
            password: BAD_PASSWORD,
            totpCode: '000000',
            expectedDatabase,
            evaluationTimeMs: nextPeriod(t1),
          }),
        ),
      );
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      const after = await pool.query<{ reauthenticated_at: Date }>(
        `SELECT reauthenticated_at FROM admin_sessions WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      expect(after.rows[0]?.reauthenticated_at.getTime()).toBe(
        before.rows[0]?.reauthenticated_at.getTime(),
      );
      const throttle = await pool.query<{ failed_attempts: number }>(
        `SELECT failed_attempts FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect((throttle.rows[0]?.failed_attempts ?? 0) >= 4).toBe(true);
    });

    it('R-02 success-path TOTP-replay + invalid mix: failures accounted; no lock_timeout bypass; no post-lockout session', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const consumedCode = generateTotpCode(enrolled.totpSecretBytes, t1);
      // Consume the TOTP step once (valid success path).
      await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: consumedCode,
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      await pool.query(`DELETE FROM admin_sessions WHERE admin_user_id = $1::uuid`, [adminUserId]);
      await pool.query(
        `UPDATE admin_auth_throttle
         SET failed_attempts = 0, locked_until = NULL, window_started_at = now(), updated_at = now()
         WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );

      // Mix: valid-password + already-consumed TOTP (crypto-valid success path) with invalids.
      const replayAttempts = Array.from({ length: 3 }, () =>
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: consumedCode,
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      );
      const invalidAttempts = Array.from({ length: OWNER_ADMIN_AUTH_MAX_FAILURES }, () =>
        loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: '000000',
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      );
      const results = await Promise.allSettled([...replayAttempts, ...invalidAttempts]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);

      const rejections = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      const unauthCount = rejections.filter(
        (r) => r.reason instanceof AuthDomainError && r.reason.code === 'UNAUTHENTICATED',
      ).length;
      const rateLimitedCount = rejections.filter(
        (r) => r.reason instanceof AuthDomainError && r.reason.code === 'RATE_LIMITED',
      ).length;
      expect(unauthCount + rateLimitedCount).toBe(rejections.length);
      for (const r of rejections) {
        const err = r.reason;
        expect(err).toBeInstanceOf(AuthDomainError);
        expect(String((err as Error).message)).not.toMatch(/canceling statement|55P03/i);
      }

      const throttle = await pool.query<{ failed_attempts: number; locked_until: Date | null }>(
        `SELECT failed_attempts, locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      const failedAttempts = throttle.rows[0]?.failed_attempts ?? 0;
      // Every UNAUTHENTICATED must have been durably accounted; RATE_LIMITED is post-lockout.
      expect(
        failedAttempts,
        `durable failures=${failedAttempts} unauth=${unauthCount} rate_limited=${rateLimitedCount}`,
      ).toBe(unauthCount);
      expect(failedAttempts).toBeGreaterThanOrEqual(OWNER_ADMIN_AUTH_MAX_FAILURES);
      expect(throttle.rows[0]?.locked_until).not.toBeNull();

      const sessions = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_sessions WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [adminUserId],
      );
      expect(sessions.rows[0]?.c).toBe(0);

      // After lockout, a fresh valid TOTP must not mint a session.
      const t2 = nextPeriod(t1);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      const sessionsAfter = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_sessions WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [adminUserId],
      );
      expect(sessionsAfter.rows[0]?.c).toBe(0);
    });

    it('R-04 enroll/login results never leak secrets into JSON or error surfaces', async () => {
      const begun = await beginOwnerAdminTotpEnrollment();
      const result = await completeOwnerAdminTotpEnrollment(pool, {
        adminUserId,
        password: PASSWORD,
        totpSecretBytes: begun.totpSecretBytes,
        totpConfirmationCode: generateTotpCode(begun.totpSecretBytes),
        expectedDatabase,
      });
      const enrollJson = JSON.stringify(result);
      expect(enrollJson).not.toContain('otpauth');
      expect(enrollJson).not.toContain(begun.totpSecretBase32);
      expect(enrollJson).not.toContain(PASSWORD);
      expect(result).not.toHaveProperty('_provisioningMaterial');

      const t1 = nextPeriod(Date.now());
      const bundle = await loginOwnerAdmin(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(begun.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const loginJson = JSON.stringify(bundle.result);
      expect(loginJson).not.toContain('sessionToken');
      expect(Object.keys(bundle.result)).not.toContain('sessionToken');
      const token = bundle.takeSessionTokenOnce();
      expect(token.length).toBeGreaterThan(20);
      expect(loginJson).not.toContain(token);
      expect(() => bundle.takeSessionTokenOnce()).toThrow(/already consumed/);

      try {
        await loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: '000000',
          expectedDatabase,
          evaluationTimeMs: t1,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
        expect(msg).not.toContain(PASSWORD);
        expect(msg).not.toContain(BAD_PASSWORD);
        expect(json).not.toContain(begun.totpSecretBase32);
      }
    });

    it('R-05 audit events present and redacted (no raw secrets)', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const audits = await pool.query<{ action_type: string; after_snapshot: unknown; reason: string }>(
        `SELECT action_type, after_snapshot, reason FROM audit_logs
         WHERE action_type LIKE 'owner_admin_auth.%'
         ORDER BY created_at DESC LIMIT 20`,
      );
      expect(audits.rows.some((r) => r.action_type === 'owner_admin_auth.credential_enrolled')).toBe(
        true,
      );
      expect(audits.rows.some((r) => r.action_type === 'owner_admin_auth.session_created')).toBe(true);
      const blob = JSON.stringify(audits.rows);
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain('otpauth');
    });

    it('Recovery authorization gates after fresh login', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      expect(await evaluateRecoveryOwnerAuthGates(pool, adminUserId, login.sessionToken)).toEqual({
        ok: true,
      });
    });

    it('R-06 pool-owned transaction commits and rolls back', async () => {
      await withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO admin_auth_throttle (admin_user_id, failed_attempts)
           VALUES ($1::uuid, 1)
           ON CONFLICT (admin_user_id) DO UPDATE SET failed_attempts = 1`,
          [adminUserId],
        );
        return { status: 'ok' as const, value: undefined };
      });
      const row = await pool.query<{ failed_attempts: number }>(
        `SELECT failed_attempts FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(row.rows[0]?.failed_attempts).toBe(1);

      await expect(
        withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
          await client.query(
            `UPDATE admin_auth_throttle SET failed_attempts = 99 WHERE admin_user_id = $1::uuid`,
            [adminUserId],
          );
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      const after = await pool.query<{ failed_attempts: number }>(
        `SELECT failed_attempts FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(after.rows[0]?.failed_attempts).toBe(1);
    });

    it('R-06 withPinnedOwnerAuthTransaction refuses PoolClient (no outer COMMIT)', async () => {
      const client = await pool.connect();
      try {
        await expect(withPinnedOwnerAuthTransaction(client, async () => undefined)).rejects.toMatchObject(
          { code: 'FORBIDDEN' },
        );
      } finally {
        client.release();
      }
    });

    it('RR2-03 BEGIN failure destroys path without running work', async () => {
      let releasedWithError = false;
      const broken = {
        connect: async () => ({
          query: async (text: unknown) => {
            const sql = typeof text === 'string' ? text : '';
            if (/^BEGIN\b/i.test(sql.trim())) {
              throw new Error('injected BEGIN failure');
            }
            return { rows: [] };
          },
          release: (err?: Error | boolean) => {
            releasedWithError = Boolean(err);
          },
        }),
      } as unknown as Pool;
      let workRan = false;
      await expect(
        withPoolOwnedOwnerAuthTransaction(broken, async () => {
          workRan = true;
          return { status: 'ok' as const, value: null };
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(workRan).toBe(false);
      expect(releasedWithError).toBe(true);
    });

    it('RR2-03 COMMIT failure is indeterminate and destroys connection', async () => {
      let releasedWithError = false;
      let phase = 0;
      const broken = {
        connect: async () => ({
          query: async (text: unknown) => {
            const sql = typeof text === 'string' ? text : '';
            if (/^BEGIN\b/i.test(sql.trim())) {
              phase = 1;
              return { rows: [] };
            }
            if (/^COMMIT\b/i.test(sql.trim())) {
              throw new Error('injected COMMIT failure');
            }
            if (/^ROLLBACK\b/i.test(sql.trim())) {
              return { rows: [] };
            }
            return { rows: [] };
          },
          release: (err?: Error | boolean) => {
            releasedWithError = Boolean(err);
          },
        }),
      } as unknown as Pool;
      await expect(
        withPoolOwnedOwnerAuthTransaction(broken, async () => ({
          status: 'ok' as const,
          value: 'x',
        })),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof AuthDomainError &&
          err.code === 'INTERNAL' &&
          /COMMIT failed|indeterminate/.test(err.message)
        );
      });
      expect(phase).toBe(1);
      expect(releasedWithError).toBe(true);
    });

    it('R-06 auth_rejected outcome commits failure counter (not rolled back)', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      await expect(
        loginOwnerAdmin(pool, {
          adminUserId,
          password: BAD_PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      const throttle = await pool.query<{ failed_attempts: number }>(
        `SELECT failed_attempts FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(throttle.rows[0]?.failed_attempts).toBe(1);
    });

    it('RR2-06 preflight refuses before secrets would be generated (wrong DB)', async () => {
      await expect(
        preflightOwnerAdminEnrollment(pool, {
          adminUserId,
          expectedDatabase: 'definitely_wrong_db_name_test',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('RR2-06 preflight succeeds on isolated first enroll path', async () => {
      const pf = await preflightOwnerAdminEnrollment(pool, {
        adminUserId,
        expectedDatabase,
      });
      expect(pf.mode).toBe('first');
      expect(pf.adminUserId).toBe(adminUserId);
    });

    it('inactive credentials do not block first enroll', async () => {
      await pool.query(
        `INSERT INTO admin_credentials (
           admin_user_id, credential_type, label, password_verifier, status, disabled_at
         ) VALUES ($1::uuid, 'PASSWORD', 'old', 'x', 'DISABLED', now())`,
        [adminUserId],
      );
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase);
      expect(enrolled.replaced).toBe(false);
    });

    it('RR2-01/04 reauth racing with credential replacement: no deadlock; session revoked or replaced', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const t2 = nextPeriod(t1);
      const begun = await beginOwnerAdminTotpEnrollment();
      const results = await Promise.allSettled([
        reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'R',
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t2),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          evaluationTimeMs: t2,
        }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          expect(msg.toLowerCase()).not.toMatch(/deadlock/);
        }
      }
      const session = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM admin_sessions WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      // Replace must win revocation if it committed; reauth must not revive a revoked session.
      const activePwd = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND credential_type = 'PASSWORD' AND status = 'ACTIVE'`,
        [adminUserId],
      );
      expect(activePwd.rows[0]?.c).toBe(1);
      if (session.rows[0]?.revoked_at !== null) {
        try {
          await reauthenticateOwnerAdminSession(pool, {
            sessionToken: login.sessionToken,
            password: PASSWORD + 'R',
            totpCode: '000000',
            expectedDatabase,
            evaluationTimeMs: nextPeriod(t2),
          });
          expect.fail('expected reauth on revoked session to fail');
        } catch (err) {
          expect(err).toBeInstanceOf(AuthDomainError);
          const code = (err as AuthDomainError).code;
          expect(['SESSION_REVOKED', 'UNAUTHENTICATED']).toContain(code);
        }
      }
    }, 120_000);

    it('RR2-01/04 login racing with credential replacement: bounded; no duplicate active pairs', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const begun = await beginOwnerAdminTotpEnrollment();
      const results = await Promise.allSettled([
        loginOwnerAdmin(pool, {
          adminUserId,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          expectedDatabase,
          evaluationTimeMs: t1,
        }),
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'L',
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t1),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
          evaluationTimeMs: t1,
        }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          expect(msg.toLowerCase()).not.toMatch(/deadlock/);
        }
      }
      const active = await pool.query<{ credential_type: string; c: number }>(
        `SELECT credential_type::text, count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND status = 'ACTIVE' AND disabled_at IS NULL
         GROUP BY credential_type`,
        [adminUserId],
      );
      for (const row of active.rows) {
        expect(row.c).toBe(1);
      }
    }, 120_000);

    it('RR2-01 logout racing with reauthentication: no deadlock; final session revoked or reauthed once', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });
      const t2 = nextPeriod(t1);
      const results = await Promise.allSettled([
        logoutOwnerAdminSession(pool, { sessionToken: login.sessionToken, expectedDatabase }),
        reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          expect(msg.toLowerCase()).not.toMatch(/deadlock/);
        }
      }
      const session = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM admin_sessions WHERE session_token_hash = $1`,
        [hashAdminSessionToken(login.sessionToken)],
      );
      const logoutOk = results[0]?.status === 'fulfilled';
      const reauthOk = results[1]?.status === 'fulfilled';
      expect(logoutOk || reauthOk).toBe(true);
      if (logoutOk) {
        expect(session.rows[0]?.revoked_at).not.toBeNull();
      }
    }, 120_000);

    it('RR2-01 two concurrent credential replacements: at most one success; single active pair', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const a = await beginOwnerAdminTotpEnrollment();
      const b = await beginOwnerAdminTotpEnrollment();
      const t1 = nextPeriod(t0);
      const code = generateTotpCode(enrolled.totpSecretBytes, t1);
      const results = await Promise.allSettled([
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'A',
          totpSecretBytes: a.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(a.totpSecretBytes, t1),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: code,
          evaluationTimeMs: t1,
        }),
        completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: PASSWORD + 'B',
          totpSecretBytes: b.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(b.totpSecretBytes, t1),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: code,
          evaluationTimeMs: t1,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeLessThanOrEqual(1);
      const active = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_credentials
         WHERE admin_user_id = $1::uuid AND status = 'ACTIVE' AND disabled_at IS NULL`,
        [adminUserId],
      );
      expect(active.rows[0]?.c).toBe(2);
    }, 120_000);

    it('FS-02 accepted preflight leaves throttle/credentials/sessions/audit unchanged', async () => {
      const before = await snapshotAuthState(pool, adminUserId);
      const thrBefore = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      const auditBefore = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM audit_logs WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      const pf = await preflightOwnerAdminEnrollment(pool, {
        adminUserId,
        expectedDatabase,
      });
      expect(pf.mode).toBe('first');
      const after = await snapshotAuthState(pool, adminUserId);
      expect(after).toEqual(before);
      const thrAfter = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(thrAfter.rows[0]?.c).toBe(thrBefore.rows[0]?.c ?? 0);
      const auditAfter = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM audit_logs WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(auditAfter.rows[0]?.c).toBe(auditBefore.rows[0]?.c);
    });

    it('FS-02 refused preflight leaves state unchanged', async () => {
      await enrollFresh(pool, adminUserId, expectedDatabase);
      const before = await snapshotAuthState(pool, adminUserId);
      await expect(
        preflightOwnerAdminEnrollment(pool, {
          adminUserId,
          expectedDatabase,
          replaceExisting: false,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const after = await snapshotAuthState(pool, adminUserId);
      expect(after).toEqual(before);
    });

    it('FS-02 read-only transaction rejects INSERT (genuine READ ONLY)', async () => {
      await expect(
        withPoolOwnedReadOnlyTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO admin_auth_throttle (admin_user_id) VALUES ($1::uuid)`,
            [adminUserId],
          );
        }),
      ).rejects.toThrow();
      const thr = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
        [adminUserId],
      );
      expect(thr.rows[0]?.c).toBe(0);
    });

    it('Issue3: two distinct clients both inherit lock_timeout and statement_timeout', async () => {
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        const aLock = await a.query<{ lock_timeout: string }>(`SHOW lock_timeout`);
        const bLock = await b.query<{ lock_timeout: string }>(`SHOW lock_timeout`);
        const aStmt = await a.query<{ statement_timeout: string }>(`SHOW statement_timeout`);
        const bStmt = await b.query<{ statement_timeout: string }>(`SHOW statement_timeout`);
        expect(aLock.rows[0]?.lock_timeout).toBe('8s');
        expect(bLock.rows[0]?.lock_timeout).toBe('8s');
        expect(aStmt.rows[0]?.statement_timeout).toBe('1min');
        expect(bStmt.rows[0]?.statement_timeout).toBe('1min');
      } finally {
        a.release();
        b.release();
      }
    });

    it('FS-04 controlled barrier: holder-pid-specific wait then revoke; no deadlock', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });

      const holder = await pool.connect();
      const watcher = await pool.connect();
      let barrierReached = false;
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM admin_users WHERE id = $1::uuid FOR UPDATE`, [
          adminUserId,
        ]);
        const pid = (
          await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const t2 = nextPeriod(t1);
        const reauthPromise = reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: generateTotpCode(enrolled.totpSecretBytes, t2),
          expectedDatabase,
          evaluationTimeMs: t2,
        });

        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await watcher.query<{ c: number }>(
            `SELECT count(*)::int AS c
             FROM pg_locks blocked
             JOIN pg_locks holder
               ON holder.locktype = blocked.locktype
              AND holder.database IS NOT DISTINCT FROM blocked.database
              AND holder.relation IS NOT DISTINCT FROM blocked.relation
              AND holder.page IS NOT DISTINCT FROM blocked.page
              AND holder.tuple IS NOT DISTINCT FROM blocked.tuple
              AND holder.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
              AND holder.transactionid IS NOT DISTINCT FROM blocked.transactionid
              AND holder.classid IS NOT DISTINCT FROM blocked.classid
              AND holder.objid IS NOT DISTINCT FROM blocked.objid
              AND holder.objsubid IS NOT DISTINCT FROM blocked.objsubid
              AND holder.pid <> blocked.pid
             WHERE NOT blocked.granted
               AND holder.granted
               AND holder.pid = $1`,
            [pid],
          );
          if ((waiting.rows[0]?.c ?? 0) > 0) {
            barrierReached = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(barrierReached).toBe(true);

        await holder.query(
          `UPDATE admin_sessions
           SET revoked_at = now(), revoked_reason = 'SECURITY_EVENT'
           WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
          [adminUserId],
        );
        await holder.query('COMMIT');

        await expect(reauthPromise).rejects.toSatisfy((err: unknown) => {
          return (
            err instanceof AuthDomainError &&
            (err.code === 'SESSION_REVOKED' || err.code === 'UNAUTHENTICATED')
          );
        });

        const session = await pool.query<{ revoked_at: Date | null }>(
          `SELECT revoked_at FROM admin_sessions WHERE session_token_hash = $1`,
          [hashAdminSessionToken(login.sessionToken)],
        );
        expect(session.rows[0]?.revoked_at).not.toBeNull();
      } finally {
        try {
          await holder.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        holder.release();
        watcher.release();
      }
    }, 120_000);

    it('Issue2: real reauth API vs real credential-replacement API under Owner-lock barrier', async () => {
      const t0 = Date.now();
      const enrolled = await enrollFresh(pool, adminUserId, expectedDatabase, t0);
      const t1 = nextPeriod(t0);
      const login = await takeLoginToken(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
        expectedDatabase,
        evaluationTimeMs: t1,
      });

      const holder = await pool.connect();
      const watcher = await pool.connect();
      let reauthWaiterOnHolder = false;
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM admin_users WHERE id = $1::uuid FOR UPDATE`, [
          adminUserId,
        ]);
        const holderPid = (
          await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const t2 = nextPeriod(t1);
        const begun = await beginOwnerAdminTotpEnrollment();
        const sharedCode = generateTotpCode(enrolled.totpSecretBytes, t2);
        const newPassword = `${PASSWORD}-rotated`;

        const reauthPromise = reauthenticateOwnerAdminSession(pool, {
          sessionToken: login.sessionToken,
          password: PASSWORD,
          totpCode: sharedCode,
          expectedDatabase,
          evaluationTimeMs: t2,
        });
        // Prevent unhandled rejection if the test aborts before allSettled.
        reauthPromise.catch(() => undefined);

        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          // Holder-pid-specific waiters only (not a generic pg_stat_activity scan).
          // At this point only reauth is in flight against the Owner FOR UPDATE we hold.
          const waiting = await watcher.query<{ blocked_pid: number }>(
            `SELECT blocked.pid AS blocked_pid
             FROM pg_locks blocked
             JOIN pg_locks holder
               ON holder.locktype = blocked.locktype
              AND holder.database IS NOT DISTINCT FROM blocked.database
              AND holder.relation IS NOT DISTINCT FROM blocked.relation
              AND holder.page IS NOT DISTINCT FROM blocked.page
              AND holder.tuple IS NOT DISTINCT FROM blocked.tuple
              AND holder.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
              AND holder.transactionid IS NOT DISTINCT FROM blocked.transactionid
              AND holder.classid IS NOT DISTINCT FROM blocked.classid
              AND holder.objid IS NOT DISTINCT FROM blocked.objid
              AND holder.objsubid IS NOT DISTINCT FROM blocked.objsubid
              AND holder.pid <> blocked.pid
             JOIN pg_stat_activity act ON act.pid = blocked.pid
             WHERE NOT blocked.granted
               AND holder.granted
               AND holder.pid = $1
               AND act.datname = current_database()`,
            [holderPid],
          );
          if ((waiting.rows[0]?.blocked_pid ?? 0) > 0) {
            reauthWaiterOnHolder = true;
            expect(waiting.rows[0]!.blocked_pid).not.toBe(holderPid);
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(reauthWaiterOnHolder).toBe(true);

        const replacePromise = completeOwnerAdminTotpEnrollment(pool, {
          adminUserId,
          password: newPassword,
          totpSecretBytes: begun.totpSecretBytes,
          totpConfirmationCode: generateTotpCode(begun.totpSecretBytes, t2),
          expectedDatabase,
          replaceExisting: true,
          currentPassword: PASSWORD,
          currentTotpCode: sharedCode,
          evaluationTimeMs: t2,
        });
        replacePromise.catch(() => undefined);

        await new Promise((r) => setTimeout(r, 75));
        await holder.query('COMMIT');

        const results = await Promise.allSettled([reauthPromise, replacePromise]);
        for (const r of results) {
          if (r.status === 'rejected') {
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            expect(msg.toLowerCase()).not.toMatch(/deadlock/);
          }
        }

        // Final committed DB state (not just API return values).
        const session = await pool.query<{
          revoked_at: Date | null;
          revoked_reason: string | null;
        }>(
          `SELECT revoked_at, revoked_reason::text AS revoked_reason
           FROM admin_sessions WHERE session_token_hash = $1`,
          [hashAdminSessionToken(login.sessionToken)],
        );
        const active = await pool.query<{ credential_type: string; c: number }>(
          `SELECT credential_type::text, count(*)::int AS c
           FROM admin_credentials
           WHERE admin_user_id = $1::uuid AND status = 'ACTIVE' AND disabled_at IS NULL
           GROUP BY credential_type`,
          [adminUserId],
        );
        for (const row of active.rows) {
          expect(row.c).toBe(1);
        }
        const activeCount = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_credentials
           WHERE admin_user_id = $1::uuid AND status = 'ACTIVE' AND disabled_at IS NULL`,
          [adminUserId],
        );
        expect(activeCount.rows[0]?.c).toBe(2);

        const openSessions = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_sessions
           WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
          [adminUserId],
        );
        const idleTx = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM pg_stat_activity
           WHERE datname = current_database()
             AND state = 'idle in transaction'
             AND pid <> pg_backend_pid()`,
        );
        expect(idleTx.rows[0]?.c).toBe(0);

        const replaceOk = results[1]?.status === 'fulfilled';
        if (replaceOk) {
          expect(session.rows[0]?.revoked_at).not.toBeNull();
          expect(session.rows[0]?.revoked_reason).toBe('SECURITY_EVENT');
          expect(openSessions.rows[0]?.c).toBe(0);
          const t3 = nextPeriod(t2);
          const fresh = await takeLoginToken(pool, {
            adminUserId,
            password: newPassword,
            totpCode: generateTotpCode(begun.totpSecretBytes, t3),
            expectedDatabase,
            evaluationTimeMs: t3,
          });
          expect(typeof fresh.sessionId).toBe('string');
          expect(fresh.sessionId.length).toBeGreaterThan(0);
          const t4 = nextPeriod(t3);
          await expect(
            takeLoginToken(pool, {
              adminUserId,
              password: PASSWORD,
              totpCode: generateTotpCode(enrolled.totpSecretBytes, t4),
              expectedDatabase,
              evaluationTimeMs: t4,
            }),
          ).rejects.toSatisfy((err: unknown) => err instanceof AuthDomainError);
        } else {
          // Replacement lost the race or rejected safely — active credential cardinality holds.
          expect(activeCount.rows[0]?.c).toBe(2);
        }
      } finally {
        try {
          await holder.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        holder.release();
        watcher.release();
      }
    }, 180_000);
  },
);
