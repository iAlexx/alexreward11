/**
 * Phase 20 Step 2 — referral attribution smoke (disposable DB).
 * TEST / DISPOSABLE DB ONLY — self-referral + ALREADY_ATTRIBUTED.
 *
 * Gate: PHASE20_DATABASE_URL, or PHASE15_DATABASE_URL, or
 * PHASE20_STEP2_REQUIRE_DB_GATES=1 (required), or PHASE20_REFERRAL_TESTS=1 + DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { attributeReferralCode } from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertReferralCode,
  resetAndMigrate,
} from './harness.js';

function resolvePhase20DatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? process.env.PHASE15_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP2_REQUIRE_DB_GATES === '1') {
    throw new Error(
      'PHASE20_STEP2_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL (disposable *_test DB)',
    );
  }
  if (process.env.PHASE20_REFERRAL_TESTS === '1') {
    return process.env.DATABASE_URL ?? '';
  }
  return '';
}

const dbUrl = resolvePhase20DatabaseUrl();

describe.skipIf(dbUrl === '')('Phase 20 referral controlled attribution (DB)', () => {
  let pool!: Pool;
  let referrerId!: string;
  const CODE = 'P20RefSmoke';

  beforeAll(async () => {
    // TEST/DISPOSABLE ONLY
    await resetAndMigrate(dbUrl);
    pool = createPool(dbUrl);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE referral_reward_events, referral_edges, referral_codes, users
      RESTART IDENTITY CASCADE
    `);
    referrerId = await createTestUser(pool, '20200001');
    await insertReferralCode(pool, { userId: referrerId, code: CODE });
  });

  async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  it('returns SELF_REFERRAL without creating edges', async () => {
    await expect(
      withTx((client) =>
        attributeReferralCode(client, { referredUserId: referrerId, code: CODE }),
      ),
    ).resolves.toEqual({ outcome: 'SELF_REFERRAL' });

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges`,
    );
    expect(count.rows[0]?.c).toBe(0);
  });

  it('returns ALREADY_ATTRIBUTED without mutating the winning edge', async () => {
    const invitee = await createTestUser(pool, '20200002');
    const first = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: CODE }),
    );
    expect(first.outcome).toBe('ATTRIBUTED');
    if (first.outcome !== 'ATTRIBUTED') throw new Error('expected ATTRIBUTED');

    const otherReferrer = await createTestUser(pool, '20200003');
    await insertReferralCode(pool, { userId: otherReferrer, code: 'P20Other' });
    const second = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: 'P20Other' }),
    );
    expect(second).toMatchObject({
      outcome: 'ALREADY_ATTRIBUTED',
      edgeId: first.edgeId,
    });
  });
});