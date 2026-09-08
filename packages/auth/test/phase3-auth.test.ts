/**
 * Phase 3 Telegram auth + Founder claim integration suite.
 *
 * Destructive against an explicitly nominated database (drops public schema and
 * re-applies Phase 2 migrations). Requires:
 *   PHASE3_DATABASE_URL or (PHASE3_AUTH_TESTS=1 + DATABASE_URL)
 */
import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildSignedInitDataForTests } from '@alex-rewards/telegram';
import { migrateDatabase } from '@alex-rewards/db';

import {
  AuthDomainError,
  authenticateWithTelegramInitData,
  claimFounderCode,
  generateClaimCode,
  getMembershipView,
  hashClaimCode,
  redactSensitive,
  revokeAllUserSessions,
  revokeSession,
  rotateRefreshSession,
  verifyAccessToken,
} from '../src/index.js';

const explicitUrl = process.env.PHASE3_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE3_AUTH_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const BOT = 'phase3-local-only-telegram-bot-token';
const ACCESS_SECRET = 'phase3-local-only-session-access-secret!!';

const sessionConfig = {
  accessSecret: ACCESS_SECRET,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 86_400,
};

async function resetSchema(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

async function countRows(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ c: number }>(sql, params);
  return result.rows[0]?.c ?? -1;
}

async function ensureIssuerAdmin(pool: Pool): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM admin_users WHERE email = 'phase3-issuer@local.test'`,
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ('phase3-issuer@local.test', 'Phase 3 Issuer', 'ACTIVE')
     RETURNING id`,
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('admin insert failed');
  return id;
}

async function insertOpenClaimCode(
  pool: Pool,
  adminId: string,
  options: { expiresAt?: Date | null; reserved?: number | null } = {},
): Promise<{ raw: string; hash: string }> {
  const raw = generateClaimCode(24);
  const hash = hashClaimCode(raw);
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  await pool.query(
    `INSERT INTO membership_claim_codes (
       code_hash, membership_plan_id, created_by_admin_id, expires_at, founder_number_reserved
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      hash,
      planId,
      adminId,
      options.expiresAt === undefined ? null : options.expiresAt,
      options.reserved ?? null,
    ],
  );
  return { raw, hash };
}

function signedInitData(
  telegramUserId: string | number,
  overrides: Record<string, unknown> = {},
  authDate = Math.floor(Date.now() / 1000),
): string {
  return buildSignedInitDataForTests(BOT, {
    user: JSON.stringify({
      id: telegramUserId,
      first_name: 'Phase',
      username: 'phase3_user',
      language_code: 'en',
      ...overrides,
    }),
    auth_date: String(authDate),
  });
}

describe.skipIf(databaseUrl === '')('Phase 3 auth + membership binding', () => {
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    await resetSchema(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
    adminId = await ensureIssuerAdmin(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        audit_logs,
        membership_grant_events,
        membership_claim_codes,
        user_memberships,
        user_sessions,
        user_settings,
        user_profiles,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  it('creates a session only after valid initData and keeps telegram id string-safe', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('900000000000000001'),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(login.user.telegramUserId).toBe('900000000000000001');
    expect(typeof login.user.telegramUserId).toBe('string');
    const claims = verifyAccessToken(login.session.accessToken, ACCESS_SECRET);
    expect(claims.sub).toBe(login.user.id);
    expect(claims.sid).toBe(login.session.sessionId);
  });

  it('rejects invalid signature before creating a user', async () => {
    const raw = signedInitData(42).replace(/hash=[0-9a-f]+/, 'hash=' + 'ab'.repeat(32));
    await expect(
      authenticateWithTelegramInitData(pool, {
        rawInitData: raw,
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
    const count = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM users`);
    expect(count.rows[0]?.c).toBe(0);
  });

  it('does not create a second identity when Telegram username changes', async () => {
    await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(55, { username: 'first_name_user' }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const second = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(55, { username: 'renamed_user' }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(second.user.username).toBe('renamed_user');
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM users WHERE telegram_user_id = 55`,
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('rotates refresh credentials and rejects replay of the old refresh token', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(101),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const rotated = await rotateRefreshSession(pool, sessionConfig, login.session.refreshToken);
    expect(rotated.sessionId).not.toBe(login.session.sessionId);
    await expect(
      rotateRefreshSession(pool, sessionConfig, login.session.refreshToken),
    ).rejects.toMatchObject({ code: 'REFRESH_REPLAY' });
    const again = await rotateRefreshSession(pool, sessionConfig, rotated.refreshToken);
    expect(again.sessionId).not.toBe(rotated.sessionId);
  });

  it('revokes a session and revoke-all for security events', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(102),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const second = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(102),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(await revokeSession(pool, login.session.sessionId, login.user.id, 'USER_LOGOUT')).toBe(
      true,
    );
    await expect(
      rotateRefreshSession(pool, sessionConfig, login.session.refreshToken),
    ).rejects.toBeInstanceOf(AuthDomainError);
    const revoked = await revokeAllUserSessions(pool, second.user.id, 'SECURITY_EVENT');
    expect(revoked).toBeGreaterThanOrEqual(1);
    await expect(
      rotateRefreshSession(pool, sessionConfig, second.session.refreshToken),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('claims a Founder code exactly once and issues zero ledger rows', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(201),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const code = await insertOpenClaimCode(pool, adminId, { reserved: 7 });
    const claimed = await claimFounderCode(pool, {
      userId: login.user.id,
      rawClaimCode: code.raw,
    });
    expect(claimed.founderNumber).toBe(7);
    expect(claimed.planCode).toBe('FOUNDER_LIFETIME');

    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: code.raw }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });

    const ledger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions`,
    );
    expect(ledger.rows[0]?.c).toBe(0);
    const entries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    expect(entries.rows[0]?.c).toBe(0);

    const view = await getMembershipView(pool, login.user.id);
    expect(view.isFounder).toBe(true);
    expect(view.founderNumber).toBe(7);
    expect(view.securityBypass).toBe(false);
    expect(view.entitlements.some((item) => item.securityClassification === 'FINANCIAL')).toBe(
      false,
    );

    const audits = await pool.query<{ after_snapshot: Record<string, unknown> }>(
      `SELECT after_snapshot FROM audit_logs WHERE action_type = 'membership.founder_claim'`,
    );
    expect(JSON.stringify(audits.rows)).not.toContain(code.raw);
  });

  it('rejects unauthenticated-shaped claim input and expired/invalid codes', async () => {
    await expect(
      claimFounderCode(pool, { userId: randomUUID(), rawClaimCode: generateClaimCode() }),
    ).rejects.toBeInstanceOf(AuthDomainError);

    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(202),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: 'NOPE-NOT-REAL' }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });

    const expired = await insertOpenClaimCode(pool, adminId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: expired.raw }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('allows only one concurrent winner for the same claim code', async () => {
    const a = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(301),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const b = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(302),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const code = await insertOpenClaimCode(pool, adminId);
    const results = await Promise.allSettled([
      claimFounderCode(pool, { userId: a.user.id, rawClaimCode: code.raw }),
      claimFounderCode(pool, { userId: b.user.id, rawClaimCode: code.raw }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      await countRows(
        pool,
        `SELECT count(*)::int AS c FROM user_memberships WHERE status = 'ACTIVE'`,
      ),
    ).toBe(1);
  });

  it('rolls back a failed claim with no partial membership', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(401),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    // Force failure using an already-active Founder for the user.
    const first = await insertOpenClaimCode(pool, adminId, { reserved: 11 });
    await claimFounderCode(pool, { userId: login.user.id, rawClaimCode: first.raw });
    const second = await insertOpenClaimCode(pool, adminId, { reserved: 12 });
    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: second.raw }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    expect(
      await countRows(
        pool,
        `SELECT count(*)::int AS c FROM membership_claim_codes WHERE code_hash = $1 AND consumed_at IS NULL`,
        [second.hash],
      ),
    ).toBe(1);
    expect(
      await countRows(pool, `SELECT count(*)::int AS c FROM user_memberships WHERE user_id = $1`, [
        login.user.id,
      ]),
    ).toBe(1);
  });

  it('does not let membership bypass account restriction metadata', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(501),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const code = await insertOpenClaimCode(pool, adminId);
    await claimFounderCode(pool, { userId: login.user.id, rawClaimCode: code.raw });
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [login.user.id]);
    const view = await getMembershipView(pool, login.user.id);
    expect(view.userStatus).toBe('SUSPENDED');
    expect(view.isFounder).toBe(true);
    expect(view.securityBypass).toBe(false);
  });

  it('blocks claim for BANNED or SUSPENDED users and redacts secrets from log helpers', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(502),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [login.user.id]);
    const code = await insertOpenClaimCode(pool, adminId);
    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: code.raw }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await pool.query(`UPDATE users SET status = 'BANNED' WHERE id = $1`, [login.user.id]);
    await expect(
      claimFounderCode(pool, { userId: login.user.id, rawClaimCode: code.raw }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const redacted = redactSensitive({
      initData: 'secret-init',
      claimCode: code.raw,
      nested: { refreshToken: 'abc' },
    });
    expect(JSON.stringify(redacted)).not.toContain(code.raw);
    expect(JSON.stringify(redacted)).toContain('[REDACTED]');
  });

  it('rejects concurrent refresh races minting multiple live chains from one credential', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData(601),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    const results = await Promise.allSettled([
      rotateRefreshSession(pool, sessionConfig, login.session.refreshToken),
      rotateRefreshSession(pool, sessionConfig, login.session.refreshToken),
    ]);
    const ok = results.filter((item) => item.status === 'fulfilled');
    const bad = results.filter((item) => item.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(
      await countRows(
        pool,
        `SELECT count(*)::int AS c FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
        [login.user.id],
      ),
    ).toBe(1);
  });
});
