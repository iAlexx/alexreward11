/**
 * Phase 12 remediation P12-03 — payout privacy persistence.
 *
 * Opt-in destructive: PHASE12_DATABASE_URL, or PHASE12_API_TESTS=1 + DATABASE_URL.
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  patchUserSettings,
  readUserSettings,
  SettingsWriteError,
} from '../src/me/settings-write.js';

const explicitUrl = process.env.PHASE12_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE12_API_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

describe.skipIf(databaseUrl === '')('Phase 12 settings privacy persistence', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    assertSafeDestructiveTestDatabaseUrl(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await assertConnectedDestructiveTestDatabase(client);
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    } finally {
      await client.end();
    }
    await migrateDatabase(databaseUrl);

    pool = new Pool({ connectionString: databaseUrl });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, preferred_locale)
       VALUES ($1::bigint, 'en')
       RETURNING id`,
      ['912120300101'],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('user insert failed');
    userId = id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('persists publicPayoutIdentityMode and keeps security notifications locked on', async () => {
    const initial = await readUserSettings(pool, userId);
    expect(initial.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');
    expect(initial.securityNotificationsEnabled).toBe(true);

    const shown = await patchUserSettings(pool, {
      userId,
      patch: { publicPayoutIdentityMode: 'SHOW_USERNAME' },
    });
    expect(shown.publicPayoutIdentityMode).toBe('SHOW_USERNAME');
    expect(shown.securityNotificationsEnabled).toBe(true);

    const reread = await readUserSettings(pool, userId);
    expect(reread.publicPayoutIdentityMode).toBe('SHOW_USERNAME');

    const hidden = await patchUserSettings(pool, {
      userId,
      patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY', preferredLocale: 'ar' },
    });
    expect(hidden.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');
    expect(hidden.preferredLocale).toBe('ar');
    expect(hidden.securityNotificationsEnabled).toBe(true);

    const row = await pool.query<{
      public_payout_identity_mode: string;
      security_notifications_enabled: boolean;
      locale: string;
    }>(
      `SELECT public_payout_identity_mode::text AS public_payout_identity_mode,
              security_notifications_enabled,
              locale
       FROM user_settings
       WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(row.rows[0]?.public_payout_identity_mode).toBe('HIDE_IDENTITY');
    expect(row.rows[0]?.security_notifications_enabled).toBe(true);
    expect(row.rows[0]?.locale).toBe('ar');

    await expect(
      patchUserSettings(pool, {
        userId,
        patch: { publicPayoutIdentityMode: 'SHOW_EVERYTHING' as never },
      }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
  });
});
