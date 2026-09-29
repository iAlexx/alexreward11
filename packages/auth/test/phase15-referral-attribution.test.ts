/**
 * Phase 15 Step 2 — signed login-time PENDING referral attribution.
 *
 * Destructive against PHASE15_DATABASE_URL / PHASE3_DATABASE_URL /
 * (PHASE15_AUTH_TESTS=1 + DATABASE_URL).
 */
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildSignedInitDataForTests } from '@alex-rewards/telegram';
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';

import { authenticateWithTelegramInitData } from '../src/index.js';

const explicitUrl =
  process.env.PHASE15_DATABASE_URL ?? process.env.PHASE3_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE15_AUTH_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const BOT = 'phase15-local-only-telegram-bot-token';
const ACCESS_SECRET = 'phase15-local-only-session-access-secret!!';

const sessionConfig = {
  accessSecret: ACCESS_SECRET,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 86_400,
};

async function resetSchema(url: string): Promise<void> {
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

function signedInitData(
  telegramUserId: string | number,
  options: { readonly startParam?: string; readonly authDate?: number } = {},
): string {
  const fields: Record<string, string> = {
    user: JSON.stringify({
      id: telegramUserId,
      first_name: 'Phase',
      username: 'phase15_user',
      language_code: 'en',
    }),
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
  };
  if (options.startParam !== undefined) {
    fields.start_param = options.startParam;
  }
  return buildSignedInitDataForTests(BOT, fields);
}

describe.skipIf(databaseUrl === '')('Phase 15 auth referral attribution', () => {
  let pool: Pool;
  let referrerId: string;
  const CODE = 'AuthRefCode01';

  beforeAll(async () => {
    await resetSchema(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await assertConnectedDestructiveTestDatabase(pool);
    await pool.query(`
      TRUNCATE TABLE
        referral_reward_events,
        referral_edges,
        referral_codes,
        user_sessions,
        user_settings,
        user_profiles,
        users
      RESTART IDENTITY CASCADE
    `);
    const referrer = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300001'),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    referrerId = referrer.user.id;
    await pool.query(
      `INSERT INTO referral_codes (user_id, code, status)
       VALUES ($1::uuid, $2, 'ACTIVE'::activation_status)`,
      [referrerId, CODE],
    );
  });

  it('attributes PENDING edge on first login with valid signed ref_ code', async () => {
    const login = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300002', { startParam: `ref_${CODE}` }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(login.user.created).toBe(true);
    expect(login.referral?.outcome).toBe('ATTRIBUTED');
    expect(login.telegram.startParam).toBe(`ref_${CODE}`);

    const edge = await pool.query<{
      state: string;
      referrer_user_id: string;
      referred_user_id: string;
      activation_rule_version: number | null;
      activated_at: Date | null;
    }>(
      `SELECT state::text AS state, referrer_user_id, referred_user_id,
              activation_rule_version, activated_at
       FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [login.user.id],
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0]).toMatchObject({
      state: 'PENDING',
      referrer_user_id: referrerId,
      referred_user_id: login.user.id,
      activation_rule_version: null,
      activated_at: null,
    });
  });

  it('creates no edge for missing / unrelated / malformed start_param', async () => {
    const missing = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300003'),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(missing.user.created).toBe(true);
    expect(missing.referral).toEqual({ outcome: 'NO_REFERRAL' });

    const unrelated = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300004', { startParam: 'campaign_test' }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(unrelated.referral).toEqual({ outcome: 'NO_REFERRAL' });

    const malformed = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300005', { startParam: 'ref_' }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(malformed.referral).toEqual({ outcome: 'INVALID_REFERRAL_START_PARAM' });

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges`,
    );
    expect(count.rows[0]?.c).toBe(0);
  });

  it('does not block login for unknown or disabled codes', async () => {
    const unknown = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300006', { startParam: 'ref_UnknownCode' }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(unknown.user.created).toBe(true);
    expect(unknown.referral?.outcome).toBe('CODE_NOT_FOUND');
    expect(unknown.session.accessToken.length).toBeGreaterThan(10);

    await pool.query(
      `UPDATE referral_codes SET status = 'DISABLED'::activation_status WHERE code = $1`,
      [CODE],
    );
    const disabled = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300007', { startParam: `ref_${CODE}` }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(disabled.user.created).toBe(true);
    expect(disabled.referral?.outcome).toBe('CODE_DISABLED');

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges`,
    );
    expect(count.rows[0]?.c).toBe(0);
  });

  it('rejects late referral claim on existing account', async () => {
    const first = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300008'),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(first.user.created).toBe(true);
    expect(first.referral).toEqual({ outcome: 'NO_REFERRAL' });

    const later = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300008', { startParam: `ref_${CODE}` }),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    expect(later.user.created).toBe(false);
    expect(later.user.id).toBe(first.user.id);
    expect(later.referral).toBeUndefined();

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [first.user.id],
    );
    expect(count.rows[0]?.c).toBe(0);
  });

  it('rejects unsigned start_param / tampered referral transport', async () => {
    const valid = signedInitData('15300009', { startParam: `ref_${CODE}` });
    const hash = valid.split('&hash=')[1] ?? '';
    const tamperedBody = signedInitData('15300009', {
      startParam: 'ref_HACKED',
    }).split('&hash=')[0];
    await expect(
      authenticateWithTelegramInitData(pool, {
        rawInitData: `${tamperedBody}&hash=${hash}`,
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges`,
    );
    expect(count.rows[0]?.c).toBe(0);
  });

  it('concurrent first logins with referral create one user and one PENDING edge', async () => {
    const rawSame = signedInitData('15300010', { startParam: `ref_${CODE}` });
    const [a, b] = await Promise.all([
      authenticateWithTelegramInitData(pool, {
        rawInitData: rawSame,
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
      authenticateWithTelegramInitData(pool, {
        rawInitData: rawSame,
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
    ]);
    expect(a.user.id).toBe(b.user.id);
    expect([a.user.created, b.user.created].filter(Boolean)).toHaveLength(1);

    const users = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM users WHERE telegram_user_id = $1::bigint`,
      ['15300010'],
    );
    expect(users.rows[0]?.c).toBe(1);
    const edges = await pool.query<{ c: number; state: string }>(
      `SELECT count(*)::int AS c, min(state::text) AS state
       FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [a.user.id],
    );
    expect(edges.rows[0]?.c).toBe(1);
    expect(edges.rows[0]?.state).toBe('PENDING');
  });

  it('concurrent first logins with different referral payloads keep one immutable edge', async () => {
    const otherReferrer = await authenticateWithTelegramInitData(pool, {
      rawInitData: signedInitData('15300011'),
      botToken: BOT,
      maxAgeSeconds: 86_400,
      session: sessionConfig,
    });
    await pool.query(
      `INSERT INTO referral_codes (user_id, code, status)
       VALUES ($1::uuid, 'AltAuthCode', 'ACTIVE'::activation_status)`,
      [otherReferrer.user.id],
    );

    const [a, b] = await Promise.all([
      authenticateWithTelegramInitData(pool, {
        rawInitData: signedInitData('15300012', { startParam: `ref_${CODE}` }),
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
      authenticateWithTelegramInitData(pool, {
        rawInitData: signedInitData('15300012', { startParam: 'ref_AltAuthCode' }),
        botToken: BOT,
        maxAgeSeconds: 86_400,
        session: sessionConfig,
      }),
    ]);
    expect(a.user.id).toBe(b.user.id);
    const edges = await pool.query<{ c: number; referrer_user_id: string }>(
      `SELECT count(*)::int AS c, min(referrer_user_id::text) AS referrer_user_id
       FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [a.user.id],
    );
    expect(edges.rows[0]?.c).toBe(1);
    expect([referrerId, otherReferrer.user.id]).toContain(edges.rows[0]?.referrer_user_id);
  });
});
