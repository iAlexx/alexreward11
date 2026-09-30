/**
 * Phase 17 Step 1 — payout_publications DB integrity (state machine, immutability, privacy).
 * No Telegram send. No runtime publication builder.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bindVerifiedPrimaryWallet,
  createApprovedWithdrawal,
  createTestUser,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

async function seedDestination(pool: Pool): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO telegram_destinations (environment, purpose, chat_id, title, enabled)
     VALUES ('LOCAL', 'PUBLIC_PAYOUT_LOGS', $1::bigint, 'phase17-test', false)
     RETURNING id`,
    [String(9_100_000_000 + Math.floor(Math.random() * 1_000_000))],
  );
  return inserted.rows[0]!.id;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase17 payout_publications integrity', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let destinationId: string;
  let userId: string;
  let withdrawalId: string;
  let seq = 17_100;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    await pool.query(
      `TRUNCATE TABLE payout_publications, telegram_destinations RESTART IDENTITY CASCADE`,
    );
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
    destinationId = await seedDestination(pool);
    seq += 1;
    userId = await createTestUser(pool, String(seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
  });

  async function insertPending(opts?: {
    identity?: 'SHOW_USERNAME' | 'HIDE_IDENTITY';
    username?: string | null;
  }): Promise<string> {
    const identity = opts?.identity ?? 'HIDE_IDENTITY';
    const username = opts && 'username' in opts ? opts.username : null;
    const pub = await pool.query<{ id: string }>(
      `INSERT INTO payout_publications (
         withdrawal_id, destination_id, identity_mode, status, username_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3::public_payout_identity_mode, 'PENDING', $4
       ) RETURNING id`,
      [withdrawalId, destinationId, identity, username ?? null],
    );
    return pub.rows[0]!.id;
  }

  it('state machine transitions and terminals', async () => {
    const id = await insertPending();
    const token = randomUUID();

    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'worker-a',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '30 seconds'
       WHERE id = $1::uuid`,
      [id, token],
    );

    await pool.query(
      `UPDATE payout_publications SET status = 'FAILED' WHERE id = $1::uuid`,
      [id],
    );

    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'worker-a',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '30 seconds'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );

    await pool.query(
      `UPDATE payout_publications
       SET status = 'AMBIGUOUS',
           ambiguous_at = now()
       WHERE id = $1::uuid`,
      [id],
    );

    await expect(
      pool.query(
        `UPDATE payout_publications
         SET status = 'SENDING',
             sending_started_at = now(),
             lease_owner = 'x',
             lease_token = $2::uuid,
             lease_expires_at = now() + interval '30 seconds'
         WHERE id = $1::uuid`,
        [id, randomUUID()],
      ),
    ).rejects.toThrow(/illegal payout_publications status transition/);

    await pool.query(
      `UPDATE payout_publications
       SET status = 'PUBLISHED',
           telegram_message_id = 42,
           published_at = now(),
           ambiguous_at = NULL
       WHERE id = $1::uuid`,
      [id],
    );

    await expect(
      pool.query(`UPDATE payout_publications SET status = 'FAILED' WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/PUBLISHED|immutable|illegal/);

    // Fresh withdrawal for SKIPPED terminal
    seq += 1;
    const user2 = await createTestUser(pool, String(seq));
    await bindVerifiedPrimaryWallet(pool, user2, networkId);
    const w2 = await createApprovedWithdrawal(pool, {
      userId: user2,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const skip = await pool.query<{ id: string }>(
      `INSERT INTO payout_publications (withdrawal_id, destination_id, status)
       VALUES ($1::uuid, $2::uuid, 'PENDING') RETURNING id`,
      [w2, destinationId],
    );
    const skipId = skip.rows[0]!.id;
    await pool.query(`UPDATE payout_publications SET status = 'SKIPPED' WHERE id = $1::uuid`, [
      skipId,
    ]);
    await expect(
      pool.query(`UPDATE payout_publications SET status = 'PENDING' WHERE id = $1::uuid`, [skipId]),
    ).rejects.toThrow(/SKIPPED|terminal|illegal/);
  });

  it('rejects stale SENDING auto-retry to PENDING', async () => {
    const id = await insertPending();
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    await expect(
      pool.query(`UPDATE payout_publications SET status = 'PENDING' WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/illegal payout_publications status transition/);
  });

  it('immutability: withdrawal_id, destination_id, DELETE, PUBLISHED fields', async () => {
    const id = await insertPending({ identity: 'SHOW_USERNAME', username: 'FrozenName' });
    await expect(
      pool.query(`UPDATE payout_publications SET withdrawal_id = $2::uuid WHERE id = $1::uuid`, [
        id,
        randomUUID(),
      ]),
    ).rejects.toThrow(/withdrawal_id is immutable/);
    await expect(
      pool.query(`UPDATE payout_publications SET destination_id = $2::uuid WHERE id = $1::uuid`, [
        id,
        randomUUID(),
      ]),
    ).rejects.toThrow(/destination_id is immutable/);
    await expect(
      pool.query(`DELETE FROM payout_publications WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/DELETE rejected|append-only/);

    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    await pool.query(
      `UPDATE payout_publications
       SET status = 'PUBLISHED', telegram_message_id = 7, published_at = now()
       WHERE id = $1::uuid`,
      [id],
    );
    await expect(
      pool.query(`UPDATE payout_publications SET telegram_message_id = 8 WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/PUBLISHED|immutable/);
    await expect(
      pool.query(`UPDATE payout_publications SET published_at = now() WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/PUBLISHED|immutable/);
    await expect(
      pool.query(
        `UPDATE payout_publications
         SET identity_mode = 'HIDE_IDENTITY', username_snapshot = NULL
         WHERE id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/PUBLISHED|immutable|identity/);
  });

  it('privacy snapshot rules', async () => {
    await expect(
      insertPending({ identity: 'HIDE_IDENTITY', username: 'Someone' }),
    ).rejects.toThrow(/hide_username|check|violates/i);

    const showNull = await insertPending({ identity: 'SHOW_USERNAME', username: null });
    expect(showNull).toBeTruthy();

    seq += 1;
    const user2 = await createTestUser(pool, String(seq));
    await bindVerifiedPrimaryWallet(pool, user2, networkId);
    const w2 = await createApprovedWithdrawal(pool, {
      userId: user2,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const showUser = await pool.query<{ id: string }>(
      `INSERT INTO payout_publications (
         withdrawal_id, destination_id, identity_mode, username_snapshot
       ) VALUES ($1::uuid, $2::uuid, 'SHOW_USERNAME', 'ValidUser')
       RETURNING id`,
      [w2, destinationId],
    );
    const showId = showUser.rows[0]!.id;
    await pool.query(
      `UPDATE payout_publications
       SET identity_mode = 'HIDE_IDENTITY'
       WHERE id = $1::uuid`,
      [showId],
    );
    const row = await pool.query<{ identity_mode: string; username_snapshot: string | null }>(
      `SELECT identity_mode::text AS identity_mode, username_snapshot
       FROM payout_publications WHERE id = $1::uuid`,
      [showId],
    );
    expect(row.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
    expect(row.rows[0]?.username_snapshot).toBeNull();

    await expect(
      pool.query(
        `UPDATE payout_publications SET identity_mode = 'SHOW_USERNAME' WHERE id = $1::uuid`,
        [showId],
      ),
    ).rejects.toThrow(/cannot escalate|HIDE_IDENTITY/);
  });


  it('SENDING identity rewrite is rejected', async () => {
    const id = await insertPending({ identity: 'SHOW_USERNAME', username: 'Alice' });
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    await expect(
      pool.query(
        `UPDATE payout_publications
         SET identity_mode = 'HIDE_IDENTITY', username_snapshot = NULL
         WHERE id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/frozen|identity/i);
    await expect(
      pool.query(
        `UPDATE payout_publications SET username_snapshot = 'Bob' WHERE id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/frozen|identity/i);
  });

  it('AMBIGUOUS identity rewrite is rejected', async () => {
    const id = await insertPending({ identity: 'SHOW_USERNAME', username: 'Alice' });
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    await pool.query(
      `UPDATE payout_publications SET status = 'AMBIGUOUS', ambiguous_at = now() WHERE id = $1::uuid`,
      [id],
    );
    const frozen = await pool.query<{
      identity_mode: string;
      username_snapshot: string | null;
      identity_frozen_at: Date | null;
      sending_started_at: Date | null;
      lease_owner: string | null;
    }>(
      `SELECT identity_mode::text, username_snapshot, identity_frozen_at, sending_started_at, lease_owner
       FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(frozen.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
    expect(frozen.rows[0]?.username_snapshot).toBe('Alice');
    expect(frozen.rows[0]?.identity_frozen_at).not.toBeNull();
    expect(frozen.rows[0]?.sending_started_at).not.toBeNull();
    expect(frozen.rows[0]?.lease_owner).toBeNull();

    await expect(
      pool.query(
        `UPDATE payout_publications
         SET identity_mode = 'HIDE_IDENTITY', username_snapshot = NULL
         WHERE id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/frozen|identity/i);
    await expect(
      pool.query(
        `UPDATE payout_publications SET username_snapshot = 'Bob' WHERE id = $1::uuid`,
        [id],
      ),
    ).rejects.toThrow(/frozen|identity/i);
  });

  it('FAILED SHOW->HIDE remains allowed and clears freeze', async () => {
    const id = await insertPending({ identity: 'SHOW_USERNAME', username: 'Alice' });
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    await pool.query(`UPDATE payout_publications SET status = 'FAILED' WHERE id = $1::uuid`, [id]);
    const afterFail = await pool.query<{
      identity_frozen_at: Date | null;
      sending_started_at: Date | null;
      lease_owner: string | null;
      identity_mode: string;
      username_snapshot: string | null;
    }>(
      `SELECT identity_frozen_at, sending_started_at, lease_owner, identity_mode::text, username_snapshot
       FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(afterFail.rows[0]?.identity_frozen_at).toBeNull();
    expect(afterFail.rows[0]?.sending_started_at).toBeNull();
    expect(afterFail.rows[0]?.lease_owner).toBeNull();
    expect(afterFail.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
    expect(afterFail.rows[0]?.username_snapshot).toBe('Alice');

    await pool.query(
      `UPDATE payout_publications
       SET identity_mode = 'HIDE_IDENTITY'
       WHERE id = $1::uuid`,
      [id],
    );
    const afterHide = await pool.query<{
      identity_mode: string;
      username_snapshot: string | null;
    }>(
      `SELECT identity_mode::text, username_snapshot FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(afterHide.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
    expect(afterHide.rows[0]?.username_snapshot).toBeNull();
  });

  it('identity_frozen_at and leases are state-consistent', async () => {
    const id = await insertPending({ identity: 'SHOW_USERNAME', username: 'Alice' });
    let row = await pool.query<{ identity_frozen_at: Date | null; lease_owner: string | null }>(
      `SELECT identity_frozen_at, lease_owner FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.identity_frozen_at).toBeNull();
    expect(row.rows[0]?.lease_owner).toBeNull();

    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = now(),
           lease_owner = 'w',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute'
       WHERE id = $1::uuid`,
      [id, randomUUID()],
    );
    row = await pool.query(
      `SELECT identity_frozen_at, lease_owner FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.identity_frozen_at).not.toBeNull();
    expect(row.rows[0]?.lease_owner).toBe('w');

    await pool.query(
      `UPDATE payout_publications
       SET status = 'PUBLISHED', telegram_message_id = 99, published_at = now()
       WHERE id = $1::uuid`,
      [id],
    );
    const pub = await pool.query<{
      identity_frozen_at: Date | null;
      lease_owner: string | null;
      sending_started_at: Date | null;
      identity_mode: string;
      username_snapshot: string | null;
    }>(
      `SELECT identity_frozen_at, lease_owner, sending_started_at, identity_mode::text, username_snapshot
       FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(pub.rows[0]?.identity_frozen_at).not.toBeNull();
    expect(pub.rows[0]?.lease_owner).toBeNull();
    expect(pub.rows[0]?.sending_started_at).not.toBeNull();
    expect(pub.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
    expect(pub.rows[0]?.username_snapshot).toBe('Alice');
  });


  it('next_attempt_at defaults; attempts start at 0 (network send counter)', async () => {
    const id = await insertPending();
    const row = await pool.query<{ next_attempt_at: Date; attempts: number }>(
      `SELECT next_attempt_at, attempts FROM payout_publications WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.next_attempt_at).toBeTruthy();
    expect(row.rows[0]?.attempts).toBe(0);
  });
});