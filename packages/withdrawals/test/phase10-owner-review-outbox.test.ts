import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWithdrawalFromQuote,
  WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
  withdrawalOwnerReviewRequiredDedupeKey,
} from '../src/index.js';
import {
  createTestUser,
  createVerifiedPrimaryWallet,
  engineConfig,
  fundUserAvailable,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('phase10 owner-review Outbox on MANUAL_REVIEW', () => {
  let pool: Pool;
  let networkId: string;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    networkId = base.networkId;
    assetId = base.assetId;
  });

  it('MANUAL_REVIEW creates exactly one withdrawal.owner_review_required Outbox event', async () => {
    const userId = await createTestUser(pool, '9501');
    await createVerifiedPrimaryWallet(pool, { userId, networkId });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '5000000',
      key: randomUUID(),
    });
    const { withdrawalId, state } = await quoteAndCreate(
      pool,
      userId,
      '200000',
      randomUUID(),
    );
    expect(state).toBe('MANUAL_REVIEW');

    const rows = await pool.query<{
      event_type: string;
      dedupe_key: string;
      payload: { withdrawalId: string; expectedState: string };
      status: string;
    }>(
      `SELECT event_type, dedupe_key, payload, status::text AS status
       FROM outbox_events
       WHERE aggregate_id = $1::uuid
         AND event_type = $2`,
      [withdrawalId, WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.status).toBe('PENDING');
    expect(rows.rows[0]?.dedupe_key).toBe(
      withdrawalOwnerReviewRequiredDedupeKey(withdrawalId, 'MANUAL_REVIEW'),
    );
    expect(rows.rows[0]?.payload).toEqual({
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
    });
  });

  it('idempotent create path does not duplicate owner_review_required Outbox', async () => {
    const userId = await createTestUser(pool, '9502');
    await createVerifiedPrimaryWallet(pool, { userId, networkId });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '5000000',
      key: randomUUID(),
    });
    const key = randomUUID();
    const first = await quoteAndCreate(pool, userId, '200000', key);
    const again = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: first.quoteId,
      idempotencyKey: key,
    });
    expect(again.id).toBe(first.withdrawalId);

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type = $2`,
      [first.withdrawalId, WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('RESTRICTED → HELD does not emit owner_review_required', async () => {
    const userId = await createTestUser(pool, '9503');
    await pool.query(
      `UPDATE users SET withdrawal_status = 'RESTRICTED' WHERE id = $1::uuid`,
      [userId],
    );
    await createVerifiedPrimaryWallet(pool, { userId, networkId });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '5000000',
      key: randomUUID(),
    });
    const { withdrawalId, state } = await quoteAndCreate(
      pool,
      userId,
      '200000',
      randomUUID(),
    );
    expect(state).toBe('HELD');
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type = $2`,
      [withdrawalId, WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT],
    );
    expect(count.rows[0]?.c).toBe(0);
  });
});
