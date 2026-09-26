/**
 * Phase 10 isolated Telegram Owner bootstrap — focused positive/negative suite.
 * Disposable *_test DB only (never alex_rewards_isolated_payout_test wipe).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { buildSignedInitDataForTests } from '@alex-rewards/telegram';

import { AuthDomainError } from '../src/errors.js';
import {
  ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET,
  assertIsolatedTelegramOwnerBootstrapTarget,
  enrollIsolatedTelegramOwner,
  parseIsolatedOwnerBootstrapUrl,
  verifyOwnerTelegramIdentityForBootstrap,
} from '../src/index.js';
import {
  dbNameFromUrl,
  forceNumericLoopbackUrl,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
} from './owner-bootstrap-harness.js';

const PRESERVED_ISOLATED_DB = 'alex_rewards_isolated_payout_test';
const BOT = 'isolated-telegram-owner-bootstrap-bot-token';
const OWNER_TG = '424242424';
const OTHER_TG = '999999001';
const PASSWORD = 'Isolated-Telegram-Owner-Password-12';

const explicitUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const optedInUrl =
  process.env.OWNER_BOOTSTRAP_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const rawDatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;
const databaseUrl =
  rawDatabaseUrl !== '' ? forceNumericLoopbackUrl(rawDatabaseUrl) : '';
requireSecurityGateDatabaseUrl(databaseUrl, 'isolated-telegram-owner-bootstrap');

function signedInitData(telegramUserId: string, username = 'alice_owner'): string {
  const authDate = String(Math.floor(Date.now() / 1000));
  return buildSignedInitDataForTests(BOT, {
    user: JSON.stringify({
      id: Number(telegramUserId),
      username,
      first_name: 'Alice',
      last_name: 'Owner',
    }),
    auth_date: authDate,
  });
}

describe('isolated Telegram Owner bootstrap gates (no DB)', () => {
  it('refuses operational port 55432 and alex_rewards', () => {
    expect(() =>
      parseIsolatedOwnerBootstrapUrl(
        'postgresql://u:p@127.0.0.1:55432/alex_rewards_test',
      ),
    ).toThrow(/55432/);
    expect(() =>
      parseIsolatedOwnerBootstrapUrl('postgresql://u:p@127.0.0.1:55440/alex_rewards'),
    ).toThrow(/alex_rewards/);
  });

  it('canonical target accepts exact isolated payout DB identity', () => {
    const facts = parseIsolatedOwnerBootstrapUrl(
      'postgresql://u:p@127.0.0.1:55440/alex_rewards_isolated_payout_test',
    );
    expect(() =>
      assertIsolatedTelegramOwnerBootstrapTarget(
        facts,
        ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.databaseName,
      ),
    ).not.toThrow();
  });

  it('username never authorizes — wrong Telegram id rejected even with matching username', () => {
    const initData = signedInitData(OTHER_TG, 'correct_username');
    expect(() =>
      verifyOwnerTelegramIdentityForBootstrap({
        rawInitData: initData,
        botToken: BOT,
        configuredOwnerTelegramUserId: OWNER_TG,
      }),
    ).toThrow(/does not match configured Owner Telegram id/);
  });

  it('rejects tampered / invalid initData', () => {
    expect(() =>
      verifyOwnerTelegramIdentityForBootstrap({
        rawInitData: `${signedInitData(OWNER_TG)}&extra=1`,
        botToken: BOT,
        configuredOwnerTelegramUserId: OWNER_TG,
      }),
    ).toThrow(AuthDomainError);
  });

  it('accepts matching configured Telegram id; username is display-only', () => {
    const identity = verifyOwnerTelegramIdentityForBootstrap({
      rawInitData: signedInitData(OWNER_TG, 'any_display_name'),
      botToken: BOT,
      configuredOwnerTelegramUserId: OWNER_TG,
    });
    expect(identity.telegramUserId).toBe(OWNER_TG);
    expect(identity.displayUsername).toBe('any_display_name');
  });
});

describe.skipIf(
  databaseUrl === '' || dbNameFromUrl(databaseUrl) === PRESERVED_ISOLATED_DB,
)(
  'isolated Telegram Owner bootstrap enrollment (disposable DB)',
  { timeout: 180_000 },
  () => {
    const dbName = dbNameFromUrl(databaseUrl);
    let pool: Pool;

    beforeAll(async () => {
      process.env.ALEX_ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
      await resetIsolatedBootstrapSchema(databaseUrl);
      pool = new Pool({ connectionString: databaseUrl });
    });

    beforeEach(async () => {
      await pool.end();
      await resetIsolatedBootstrapSchema(databaseUrl);
      pool = new Pool({ connectionString: databaseUrl });
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('positive: creates one ACTIVE Owner bound to configured Telegram id', async () => {
      const result = await enrollIsolatedTelegramOwner({
        pool,
        connectionString: databaseUrl,
        expectedDatabase: dbName,
        configuredOwnerTelegramUserId: OWNER_TG,
        rawInitData: signedInitData(OWNER_TG, 'ignored_for_auth'),
        botToken: BOT,
        password: PASSWORD,
        email: 'isolated-owner@local.test',
      });
      expect(result.telegramUserId).toBe(OWNER_TG);
      const seat = await pool.query<{ holder: string | null }>(
        `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.holder).toBe(result.adminUserId);
      const row = await pool.query<{ telegram_user_id: string; status: string }>(
        `SELECT telegram_user_id::text, status::text FROM admin_users WHERE id = $1::uuid`,
        [result.adminUserId],
      );
      expect(row.rows[0]?.telegram_user_id).toBe(OWNER_TG);
      expect(row.rows[0]?.status).toBe('ACTIVE');
      const audit = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM audit_logs
          WHERE action_type = 'ISOLATED_TELEGRAM_OWNER_BOOTSTRAP'`,
      );
      expect(audit.rows[0]?.c).toBe(1);
    });

    it('negative: replay / second enroll refused when seat held', async () => {
      await enrollIsolatedTelegramOwner({
        pool,
        connectionString: databaseUrl,
        expectedDatabase: dbName,
        configuredOwnerTelegramUserId: OWNER_TG,
        rawInitData: signedInitData(OWNER_TG),
        botToken: BOT,
        password: PASSWORD,
        email: 'first@local.test',
      });
      await expect(
        enrollIsolatedTelegramOwner({
          pool,
          connectionString: databaseUrl,
          expectedDatabase: dbName,
          configuredOwnerTelegramUserId: OWNER_TG,
          rawInitData: signedInitData(OWNER_TG),
          botToken: BOT,
          password: PASSWORD,
          email: 'second@local.test',
        }),
      ).rejects.toThrow(/seat already held|OWNER binding|already bound/i);
    });

    it('negative: wrong configured Telegram id refuses before write', async () => {
      await expect(
        enrollIsolatedTelegramOwner({
          pool,
          connectionString: databaseUrl,
          expectedDatabase: dbName,
          configuredOwnerTelegramUserId: OWNER_TG,
          rawInitData: signedInitData(OTHER_TG),
          botToken: BOT,
          password: PASSWORD,
          email: 'wrong@local.test',
        }),
      ).rejects.toThrow(/does not match configured Owner Telegram id/);
      const admins = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM admin_users`,
      );
      expect(admins.rows[0]?.c).toBe(0);
    });

    it('negative: cross-DB expectedDatabase mismatch refused', async () => {
      await expect(
        enrollIsolatedTelegramOwner({
          pool,
          connectionString: databaseUrl,
          expectedDatabase: 'alex_rewards_other_crossdb_test',
          configuredOwnerTelegramUserId: OWNER_TG,
          rawInitData: signedInitData(OWNER_TG),
          botToken: BOT,
          password: PASSWORD,
          email: 'cross@local.test',
        }),
      ).rejects.toThrow(/cross-DB/i);
    });
  },
);
