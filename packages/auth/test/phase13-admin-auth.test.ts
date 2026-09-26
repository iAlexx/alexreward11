/**
 * Phase 13 Owner Admin auth extensions — WebAuthn support, recovery codes,
 * HTTP helpers, AdminSession isolation from Telegram user sessions.
 *
 * Owner matrix concepts (TESTS 1–11 where automatable without a browser authenticator):
 * 1 password-only refuse
 * 2 TOTP-only refuse
 * 3 password+TOTP ok
 * 4 recovery replay refuse
 * 5 reauth freshness
 * 6 telegram session cannot admin
 * 7 WEBAUTHN treated as supported factor
 * 8 RP ID fail-closed outside local/test
 * 9 recovery generate/consume (plaintext never in audit)
 * 10 challenge one-time consume
 * 11 assertRecentReauth / assertAdminOwnerRole
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
  assertAdminOwnerRole,
  assertNoUnsupportedActiveCredentials,
  assertRecentReauth,
  beginOwnerAdminTotpEnrollment,
  beginWebAuthnRegistration,
  completeOwnerAdminTotpEnrollment,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpCode,
  hashAdminSessionToken,
  isAdminSessionReauthFresh,
  loginViaPasswordTotp,
  loginViaRecoveryCode,
  looksLikeTelegramUserAccessToken,
  peekWebAuthnChallengeForTests,
  resolveAdminWebAuthnRpConfig,
  rotateRecoveryCodes,
  verifyAdminSessionToken,
} from '../src/index.js';

const explicitUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.PHASE13_DATABASE_URL ??
  process.env.PHASE3_DATABASE_URL ??
  '';
const optedInUrl =
  process.env.PHASE13_ADMIN_AUTH_TESTS === '1' || process.env.OWNER_ADMIN_AUTH_TESTS === '1'
    ? (process.env.DATABASE_URL ?? '')
    : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const PASSWORD = 'Owner-Test-Password-12';
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
  const email = 'owner-phase13@local.test';
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM admin_users WHERE email = $1`,
    [email],
  );
  let id = existing.rows[0]?.id;
  if (id === undefined) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Owner Phase13', 'ACTIVE')
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

function createIsolatedAuthTestPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 8,
    options: '-c lock_timeout=8s -c statement_timeout=60s',
  });
}

function nextPeriod(atMs: number): number {
  return atMs + PERIOD_MS;
}

describe('Phase 13 Owner Admin auth — pure policy (no DB)', () => {
  it('TEST 7: WEBAUTHN is a supported factor', () => {
    expect(() =>
      assertNoUnsupportedActiveCredentials([{ credential_type: 'WEBAUTHN' }]),
    ).not.toThrow();
  });

  it('TEST 8: RP ID fail-closed outside local/test when unset', () => {
    expect(() =>
      resolveAdminWebAuthnRpConfig({ deploymentEnv: 'production', rpId: '', origin: '' }),
    ).toThrow(AuthDomainError);
    expect(() =>
      resolveAdminWebAuthnRpConfig({
        deploymentEnv: 'staging',
        rpId: 'localhost',
        origin: 'http://localhost:3001',
      }),
    ).toThrow(AuthDomainError);
    const local = resolveAdminWebAuthnRpConfig({ deploymentEnv: 'local' });
    expect(local.rpId).toBe('localhost');
    expect(local.origin).toBe('http://localhost:3001');
  });

  it('TEST 6: Telegram-shaped JWT is not an admin opaque token', () => {
    expect(looksLikeTelegramUserAccessToken('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeTelegramUserAccessToken('opaque-admin-session-token-value')).toBe(false);
  });

  it('TEST 11: assertRecentReauth / assertAdminOwnerRole', () => {
    expect(() =>
      assertRecentReauth({ reauthenticatedAt: new Date().toISOString() }, ADMIN_REAUTH_MAX_AGE_MS),
    ).not.toThrow();
    expect(() =>
      assertRecentReauth(
        { reauthenticatedAt: new Date(Date.now() - ADMIN_REAUTH_MAX_AGE_MS - 1000).toISOString() },
        ADMIN_REAUTH_MAX_AGE_MS,
      ),
    ).toThrow(AuthDomainError);
    expect(() =>
      assertAdminOwnerRole({
        adminUserId: 'x',
        email: 'a@b.c',
        displayName: 'x',
        sessionId: 's',
        reauthenticatedAt: null,
        idleExpiresAt: '',
        absoluteExpiresAt: '',
        roles: ['OWNER'],
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminOwnerRole({
        adminUserId: 'x',
        email: 'a@b.c',
        displayName: 'x',
        sessionId: 's',
        reauthenticatedAt: null,
        idleExpiresAt: '',
        absoluteExpiresAt: '',
        roles: ['SUPPORT'],
      }),
    ).toThrow(AuthDomainError);
  });
});

describe.skipIf(databaseUrl === '')('Phase 13 Owner Admin auth — isolated DB', () => {
  let pool: Pool;
  let expectedDatabase: string;
  let adminUserId: string;

  beforeAll(async () => {
    await resetSchema(databaseUrl);
    expectedDatabase = dbNameFromUrl(databaseUrl);
    pool = createIsolatedAuthTestPool(databaseUrl);
    const owner = await ensureOwnerAdmin(pool);
    adminUserId = owner.id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // audit_logs is append-only — never DELETE (migration trigger rejects it).
    await pool.query(`DELETE FROM admin_web_confirmations`);
    await pool.query(`DELETE FROM admin_webauthn_challenges`);
    await pool.query(`DELETE FROM admin_recovery_codes`);
    await pool.query(`DELETE FROM admin_sessions`);
    await pool.query(`DELETE FROM admin_credentials`);
    await pool.query(`DELETE FROM admin_auth_throttle`);
  });

  async function enrollPasswordTotp(t0 = Date.now()) {
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

  it(
    'TEST 1: password-only login refuses',
    async () => {
    const enrolled = await enrollPasswordTotp();
    await expect(
      loginViaPasswordTotp(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: '000000',
        expectedDatabase,
        evaluationTimeMs: enrolled.enrolledAtMs,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    },
    30_000,
  );

  it(
    'TEST 2: TOTP-only material without password enroll refuses login',
    async () => {
    await pool.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, label, totp_secret_reference, status
       ) VALUES ($1::uuid, 'TOTP', 'totp-only', 'local-totp-seal-v1$not-a-real-seal', 'ACTIVE')`,
      [adminUserId],
    );
    await expect(
      loginViaPasswordTotp(pool, {
        adminUserId,
        password: PASSWORD,
        totpCode: '123456',
        expectedDatabase,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    },
    30_000,
  );

  it(
    'TEST 3: password+TOTP login ok + verifyAdminSessionToken',
    async () => {
    const enrolled = await enrollPasswordTotp();
    const t1 = nextPeriod(enrolled.enrolledAtMs);
    const bundle = await loginViaPasswordTotp(pool, {
      adminUserId,
      password: PASSWORD,
      totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
      expectedDatabase,
      evaluationTimeMs: t1,
    });
    const token = bundle.takeSessionTokenOnce();
    const session = await verifyAdminSessionToken(pool, token);
    expect(session.adminUserId).toBe(adminUserId);
    assertAdminOwnerRole(session);
    expect(isAdminSessionReauthFresh(session.reauthenticatedAt)).toBe(true);
    },
    30_000,
  );

  it(
    'TEST 4+9: recovery generate/consume/replay refuse; no plaintext in audit',
    async () => {
    await enrollPasswordTotp();
    const generated = await generateRecoveryCodes(pool, {
      adminUserId,
      expectedDatabase,
      count: 3,
    });
    const codes = generated.takePlaintextCodesOnce();
    expect(codes.length).toBe(3);

    const first = await loginViaRecoveryCode(pool, {
      adminUserId,
      recoveryCode: codes[0]!,
      expectedDatabase,
    });
    expect(first.result.adminUserId).toBe(adminUserId);
    const token = first.takeSessionTokenOnce();
    expect(token.length).toBeGreaterThan(20);

    await expect(
      consumeRecoveryCode(pool, {
        adminUserId,
        recoveryCode: codes[0]!,
        expectedDatabase,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const audits = await pool.query<{ after_snapshot: Record<string, unknown>; reason: string }>(
      `SELECT after_snapshot, reason FROM audit_logs
       WHERE admin_user_id = $1::uuid
         AND action_type LIKE 'owner_admin_auth.recovery%'
       ORDER BY created_at DESC`,
      [adminUserId],
    );
    const blob = JSON.stringify(audits.rows);
    for (const code of codes) {
      expect(blob).not.toContain(code);
      expect(blob).not.toContain(code.replace(/-/g, ''));
    }

    const rotated = await rotateRecoveryCodes(pool, {
      adminUserId,
      expectedDatabase,
      count: 2,
    });
    const newCodes = rotated.takePlaintextCodesOnce();
    expect(newCodes.length).toBe(2);
    await expect(
      loginViaRecoveryCode(pool, {
        adminUserId,
        recoveryCode: codes[1]!,
        expectedDatabase,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    },
    30_000,
  );

  it(
    'TEST 5: reauth freshness via assertRecentReauth',
    async () => {
    const enrolled = await enrollPasswordTotp();
    const t1 = nextPeriod(enrolled.enrolledAtMs);
    const bundle = await loginViaPasswordTotp(pool, {
      adminUserId,
      password: PASSWORD,
      totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
      expectedDatabase,
      evaluationTimeMs: t1,
    });
    const token = bundle.takeSessionTokenOnce();
    const session = await verifyAdminSessionToken(pool, token);
    expect(() => assertRecentReauth(session)).not.toThrow();

    await pool.query(
      `UPDATE admin_sessions
       SET reauthenticated_at = now() - interval '16 minutes'
       WHERE session_token_hash = $1`,
      [hashAdminSessionToken(token)],
    );
    const stale = await verifyAdminSessionToken(pool, token);
    expect(() => assertRecentReauth(stale)).toThrow(AuthDomainError);
    },
    30_000,
  );

  it(
    'TEST 6: Telegram user access token cannot verify as admin session',
    async () => {
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature';
    expect(looksLikeTelegramUserAccessToken(fakeJwt)).toBe(true);
    await expect(verifyAdminSessionToken(pool, fakeJwt)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    },
    30_000,
  );

  it(
    'TEST 10: WebAuthn registration challenge is session-bound and one-time',
    async () => {
    const enrolled = await enrollPasswordTotp();
    const t1 = nextPeriod(enrolled.enrolledAtMs);
    const bundle = await loginViaPasswordTotp(pool, {
      adminUserId,
      password: PASSWORD,
      totpCode: generateTotpCode(enrolled.totpSecretBytes, t1),
      expectedDatabase,
      evaluationTimeMs: t1,
    });
    const token = bundle.takeSessionTokenOnce();
    const session = await verifyAdminSessionToken(pool, token);
    const rp = resolveAdminWebAuthnRpConfig({ deploymentEnv: 'local' });

    await expect(
      beginWebAuthnRegistration(pool, {
        adminUserId,
        adminSessionId: session.sessionId,
        reauthenticatedAt: new Date(Date.now() - ADMIN_REAUTH_MAX_AGE_MS - 1000).toISOString(),
        rp,
        expectedDatabase,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const begun = await beginWebAuthnRegistration(pool, {
      adminUserId,
      adminSessionId: session.sessionId,
      reauthenticatedAt: session.reauthenticatedAt,
      rp,
      expectedDatabase,
    });
    expect(begun.options.challenge.length).toBeGreaterThan(10);
    const peeked = await peekWebAuthnChallengeForTests(pool, begun.challengeId);
    expect(peeked?.challenge).toBe(begun.options.challenge);
    expect(peeked?.consumedAt).toBeNull();
    const bound = await pool.query<{ admin_session_id: string | null }>(
      `SELECT admin_session_id::text FROM admin_webauthn_challenges WHERE id = $1::uuid`,
      [begun.challengeId],
    );
    expect(bound.rows[0]?.admin_session_id).toBe(session.sessionId);

    await pool.query(
      `UPDATE admin_webauthn_challenges SET consumed_at = now() WHERE id = $1::uuid`,
      [begun.challengeId],
    );
    const after = await peekWebAuthnChallengeForTests(pool, begun.challengeId);
    expect(after?.consumedAt).not.toBeNull();
    },
    30_000,
  );
});
