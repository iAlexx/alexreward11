/**
 * Phase 17 Step 1 — settings HIDE downgrades non-terminal payout publications + lock serialization.
 */
import { randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { patchUserSettings, readUserSettings } from '../src/me/settings-write.js';

const explicitUrl = process.env.PHASE12_DATABASE_URL ?? process.env.PHASE7_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE12_API_TESTS === '1' || process.env.PHASE7_WITHDRAWAL_TESTS === '1'
    ? (process.env.DATABASE_URL ?? '')
    : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

describe.skipIf(databaseUrl === '')('Phase17 settings privacy downgrade', () => {
  let pool: Pool;
  let userId: string;
  let destinationId: string;
  let withdrawalId: string;

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
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        payout_publications,
        telegram_destinations,
        withdrawals,
        withdrawal_quotes,
        user_wallets,
        user_settings,
        users,
        outbox_events
      RESTART IDENTITY CASCADE
    `);

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, preferred_locale)
       VALUES ($1::bigint, 'en') RETURNING id`,
      [String(17_900_000 + Math.floor(Math.random() * 10000))],
    );
    userId = user.rows[0]!.id;

    await pool.query(
      `INSERT INTO user_settings (user_id, locale, public_payout_identity_mode)
       VALUES ($1::uuid, 'en', 'SHOW_USERNAME')`,
      [userId],
    );

    const network = await pool.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = 'TON_TESTNET' LIMIT 1`,
    );
    const asset = await pool.query<{ id: string }>(
      `SELECT a.id FROM assets a JOIN networks n ON n.id = a.network_id
       WHERE a.symbol = 'USDT' AND n.code = 'TON_TESTNET' LIMIT 1`,
    );
    const raw = `0:${randomUUID().replace(/-/g, '')}`;
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, $3,
         true, true, 'TON_PROOF', now(), now()
       ) RETURNING id`,
      [userId, network.rows[0]!.id, raw],
    );

    let fee = await pool.query<{ id: string; rule_version: number }>(
      `SELECT id, rule_version FROM withdrawal_fee_rules
       WHERE asset_id = $1::uuid AND network_id = $2::uuid AND status = 'ACTIVE'
       LIMIT 1`,
      [asset.rows[0]!.id, network.rows[0]!.id],
    );
    if (fee.rows[0] === undefined) {
      fee = await pool.query<{ id: string; rule_version: number }>(
        `INSERT INTO withdrawal_fee_rules (
           asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps, status
         ) VALUES ($1::uuid, $2::uuid, 1, 0, 0, 'ACTIVE')
         RETURNING id, rule_version`,
        [asset.rows[0]!.id, network.rows[0]!.id],
      );
    }
    let lim = await pool.query<{ id: string; rule_version: number }>(
      `SELECT id, rule_version FROM withdrawal_limit_rules
       WHERE asset_id = $1::uuid AND network_id = $2::uuid AND status = 'ACTIVE'
       LIMIT 1`,
      [asset.rows[0]!.id, network.rows[0]!.id],
    );
    if (lim.rows[0] === undefined) {
      lim = await pool.query<{ id: string; rule_version: number }>(
        `INSERT INTO withdrawal_limit_rules (
           asset_id, network_id, rule_version,
           min_withdrawal_atomic, max_single_withdrawal_atomic,
           max_user_hourly_atomic, max_user_daily_atomic,
           max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
           wallet_change_cooldown_seconds, status
         ) VALUES (
           $1::uuid, $2::uuid, 1, 1, 1000000000, 1000000000, 1000000000,
           1000000000, 1000000000, 0, 'ACTIVE'
         ) RETURNING id, rule_version`,
        [asset.rows[0]!.id, network.rows[0]!.id],
      );
    }

    const quote = await pool.query<{ id: string }>(
      `INSERT INTO withdrawal_quotes (
         user_id, asset_id, network_id, primary_wallet_id,
         requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
         fee_rule_id, fee_rule_version, limit_rule_version, status, expires_at, consumed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         100000, 0, 100000, $5::uuid, $6, $7, 'CONSUMED',
         now() + interval '1 hour', now()
       ) RETURNING id`,
      [
        userId,
        asset.rows[0]!.id,
        network.rows[0]!.id,
        wallet.rows[0]!.id,
        fee.rows[0]!.id,
        fee.rows[0]!.rule_version,
        lim.rows[0]!.rule_version,
      ],
    );

    const w = await pool.query<{ id: string }>(
      `INSERT INTO withdrawals (
         user_id, withdrawal_quote_id, asset_id, network_id, wallet_id,
         requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
         state, risk_decision, fee_rule_id, fee_rule_version,
         idempotency_scope, idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         100000, 0, 100000, 'APPROVED', NULL, $6::uuid, $7,
         $8, $9
       ) RETURNING id`,
      [
        userId,
        quote.rows[0]!.id,
        asset.rows[0]!.id,
        network.rows[0]!.id,
        wallet.rows[0]!.id,
        fee.rows[0]!.id,
        fee.rows[0]!.rule_version,
        `phase17-settings:${userId}`,
        randomUUID(),
      ],
    );
    withdrawalId = w.rows[0]!.id;

    const dest = await pool.query<{ id: string }>(
      `INSERT INTO telegram_destinations (environment, purpose, chat_id, title, enabled)
       VALUES ('LOCAL', 'PUBLIC_PAYOUT_LOGS', $1::bigint, 'phase17-settings', false)
       RETURNING id`,
      [String(9_200_000_000 + Math.floor(Math.random() * 100000))],
    );
    destinationId = dest.rows[0]!.id;

    await pool.query(
      `INSERT INTO payout_publications (
         withdrawal_id, destination_id, identity_mode, status, username_snapshot
       ) VALUES ($1::uuid, $2::uuid, 'SHOW_USERNAME', 'PENDING', 'PublicName')`,
      [withdrawalId, destinationId],
    );
  });

  it('HIDE_IDENTITY downgrades non-terminal publications atomically', async () => {
    const before = await readUserSettings(pool, userId);
    expect(before.publicPayoutIdentityMode).toBe('SHOW_USERNAME');

    const after = await patchUserSettings(pool, {
      userId,
      patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY' },
    });
    expect(after.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');

    const pub = await pool.query<{ identity_mode: string; username_snapshot: string | null }>(
      `SELECT identity_mode::text AS identity_mode, username_snapshot
       FROM payout_publications WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(pub.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
    expect(pub.rows[0]?.username_snapshot).toBeNull();
  });


  it('privacy race FAILED outcome: HIDE applies after definite no-message', async () => {
    const pubId = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM payout_publications WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      )
    ).rows[0]!.id;

    const sender = await pool.connect();
    try {
      await sender.query('BEGIN');
      await sender.query(`SELECT id FROM payout_publications WHERE id = $1::uuid FOR UPDATE`, [
        pubId,
      ]);
      await sender.query(
        `UPDATE payout_publications
         SET status = 'SENDING',
             sending_started_at = now(),
             lease_owner = 'sender',
             lease_token = $2::uuid,
             lease_expires_at = now() + interval '1 minute',
             message_text_snapshot = 'dummy-message',
             explorer_url_snapshot = 'https://example.test/tx/dummy',
             send_request_started_at = now()
         WHERE id = $1::uuid`,
        [pubId, randomUUID()],
      );

      let hideDone = false;
      let hideError: unknown;
      const hidePromise = (async () => {
        try {
          await patchUserSettings(pool, {
            userId,
            patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY' },
          });
          hideDone = true;
        } catch (error) {
          hideError = error;
        }
      })();

      const probe = await pool.connect();
      try {
        await expect(
          probe.query(
            `SELECT id FROM payout_publications WHERE id = $1::uuid FOR UPDATE NOWAIT`,
            [pubId],
          ),
        ).rejects.toThrow(/could not obtain lock|lock/i);
      } finally {
        probe.release();
      }
      expect(hideDone).toBe(false);

      await sender.query(`UPDATE payout_publications SET status = 'FAILED' WHERE id = $1::uuid`, [
        pubId,
      ]);
      await sender.query('COMMIT');
      await hidePromise;
      expect(hideError).toBeUndefined();
      expect(hideDone).toBe(true);

      const settings = await readUserSettings(pool, userId);
      expect(settings.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');
      const pub = await pool.query<{
        status: string;
        identity_mode: string;
        username_snapshot: string | null;
        identity_frozen_at: Date | null;
      }>(
        `SELECT status::text, identity_mode::text, username_snapshot, identity_frozen_at
         FROM payout_publications WHERE id = $1::uuid`,
        [pubId],
      );
      expect(pub.rows[0]?.status).toBe('FAILED');
      expect(pub.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
      expect(pub.rows[0]?.username_snapshot).toBeNull();
      expect(pub.rows[0]?.identity_frozen_at).toBeNull();
    } finally {
      try {
        await sender.query('ROLLBACK');
      } catch {
        /* committed */
      }
      sender.release();
    }
  });

  it('privacy race AMBIGUOUS outcome: setting HIDE, snapshot preserved', async () => {
    const pubId = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM payout_publications WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      )
    ).rows[0]!.id;

    const sender = await pool.connect();
    try {
      await sender.query('BEGIN');
      await sender.query(`SELECT id FROM payout_publications WHERE id = $1::uuid FOR UPDATE`, [
        pubId,
      ]);
      await sender.query(
        `UPDATE payout_publications
         SET status = 'SENDING',
             sending_started_at = now(),
             lease_owner = 'sender',
             lease_token = $2::uuid,
             lease_expires_at = now() + interval '1 minute',
             message_text_snapshot = 'dummy-message',
             explorer_url_snapshot = 'https://example.test/tx/dummy',
             send_request_started_at = now()
         WHERE id = $1::uuid`,
        [pubId, randomUUID()],
      );

      let hideDone = false;
      const hidePromise = (async () => {
        await patchUserSettings(pool, {
          userId,
          patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY' },
        });
        hideDone = true;
      })();

      expect(hideDone).toBe(false);
      await sender.query(
        `UPDATE payout_publications
         SET status = 'AMBIGUOUS', ambiguous_at = now()
         WHERE id = $1::uuid`,
        [pubId],
      );
      await sender.query('COMMIT');
      await hidePromise;
      expect(hideDone).toBe(true);

      const settings = await readUserSettings(pool, userId);
      expect(settings.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');
      const pub = await pool.query<{
        status: string;
        identity_mode: string;
        username_snapshot: string | null;
        identity_frozen_at: Date | null;
      }>(
        `SELECT status::text, identity_mode::text, username_snapshot, identity_frozen_at
         FROM payout_publications WHERE id = $1::uuid`,
        [pubId],
      );
      expect(pub.rows[0]?.status).toBe('AMBIGUOUS');
      expect(pub.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
      expect(pub.rows[0]?.username_snapshot).toBe('PublicName');
      expect(pub.rows[0]?.identity_frozen_at).not.toBeNull();
    } finally {
      try {
        await sender.query('ROLLBACK');
      } catch {
        /* committed */
      }
      sender.release();
    }
  });

  it('privacy race PUBLISHED outcome: setting HIDE, published proof preserved', async () => {
    const pubId = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM payout_publications WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      )
    ).rows[0]!.id;

    const sender = await pool.connect();
    try {
      await sender.query('BEGIN');
      await sender.query(`SELECT id FROM payout_publications WHERE id = $1::uuid FOR UPDATE`, [
        pubId,
      ]);
      await sender.query(
        `UPDATE payout_publications
         SET status = 'SENDING',
             sending_started_at = now(),
             lease_owner = 'sender',
             lease_token = $2::uuid,
             lease_expires_at = now() + interval '1 minute',
             message_text_snapshot = 'dummy-message',
             explorer_url_snapshot = 'https://example.test/tx/dummy',
             send_request_started_at = now()
         WHERE id = $1::uuid`,
        [pubId, randomUUID()],
      );

      const hidePromise = patchUserSettings(pool, {
        userId,
        patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY' },
      });

      await sender.query(
        `UPDATE payout_publications
         SET status = 'PUBLISHED',
             telegram_message_id = 12345,
             published_at = now()
         WHERE id = $1::uuid`,
        [pubId],
      );
      await sender.query('COMMIT');
      await hidePromise;

      const settings = await readUserSettings(pool, userId);
      expect(settings.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');
      const pub = await pool.query<{
        status: string;
        identity_mode: string;
        username_snapshot: string | null;
      }>(
        `SELECT status::text, identity_mode::text, username_snapshot
         FROM payout_publications WHERE id = $1::uuid`,
        [pubId],
      );
      expect(pub.rows[0]?.status).toBe('PUBLISHED');
      expect(pub.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
      expect(pub.rows[0]?.username_snapshot).toBe('PublicName');
    } finally {
      try {
        await sender.query('ROLLBACK');
      } catch {
        /* committed */
      }
      sender.release();
    }
  });

  it('HIDE first then future sender lock observes HIDE on PENDING', async () => {
    await patchUserSettings(pool, {
      userId,
      patch: { publicPayoutIdentityMode: 'HIDE_IDENTITY' },
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        identity_mode: string;
        username_snapshot: string | null;
      }>(
        `SELECT identity_mode::text AS identity_mode, username_snapshot
         FROM payout_publications
         WHERE withdrawal_id = $1::uuid
         FOR UPDATE`,
        [withdrawalId],
      );
      expect(locked.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
      expect(locked.rows[0]?.username_snapshot).toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
