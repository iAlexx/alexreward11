import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { attributeReferralCode } from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertReferralCode,
  phase15DatabaseUrl,
  resetAndMigrate,
  waitForBlockedOnHolder,
} from './harness.js';

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 attributeReferralCode', () => {
  let pool: Pool;
  let referrerId: string;
  let codeId: string;
  const CODE = 'Step2CodeExact';

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE referral_reward_events, referral_edges, referral_codes, users
      RESTART IDENTITY CASCADE
    `);
    referrerId = await createTestUser(pool, '15200001');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: CODE });
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

  it('attributes ACTIVE code to PENDING edge with null activation fields', async () => {
    const invitee = await createTestUser(pool, '15200002');
    const result = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: CODE }),
    );
    expect(result).toMatchObject({
      outcome: 'ATTRIBUTED',
      referrerUserId: referrerId,
      codeId,
      state: 'PENDING',
    });
    const edge = await pool.query<{
      state: string;
      activation_rule_version: number | null;
      activated_at: Date | null;
      rejected_at: Date | null;
      rejection_reason: string | null;
    }>(
      `SELECT state::text AS state, activation_rule_version, activated_at,
              rejected_at, rejection_reason
       FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [invitee],
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0]).toMatchObject({
      state: 'PENDING',
      activation_rule_version: null,
      activated_at: null,
      rejected_at: null,
      rejection_reason: null,
    });
  });

  it('returns CODE_NOT_FOUND / CODE_DISABLED / SELF_REFERRAL without edges', async () => {
    const invitee = await createTestUser(pool, '15200003');
    await expect(
      withTx((client) =>
        attributeReferralCode(client, { referredUserId: invitee, code: 'missing' }),
      ),
    ).resolves.toEqual({ outcome: 'CODE_NOT_FOUND' });

    await pool.query(
      `UPDATE referral_codes SET status = 'DISABLED'::activation_status WHERE id = $1::uuid`,
      [codeId],
    );
    await expect(
      withTx((client) =>
        attributeReferralCode(client, { referredUserId: invitee, code: CODE }),
      ),
    ).resolves.toEqual({ outcome: 'CODE_DISABLED' });

    await pool.query(
      `UPDATE referral_codes SET status = 'ACTIVE'::activation_status WHERE id = $1::uuid`,
      [codeId],
    );
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
    const invitee = await createTestUser(pool, '15200004');
    const first = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: CODE }),
    );
    expect(first.outcome).toBe('ATTRIBUTED');
    if (first.outcome !== 'ATTRIBUTED') throw new Error('expected ATTRIBUTED');

    const otherReferrer = await createTestUser(pool, '15200005');
    await insertReferralCode(pool, { userId: otherReferrer, code: 'OtherCode' });
    const second = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: 'OtherCode' }),
    );
    expect(second).toMatchObject({
      outcome: 'ALREADY_ATTRIBUTED',
      edgeId: first.edgeId,
      state: 'PENDING',
    });
    const edges = await pool.query(
      `SELECT referrer_user_id, code_id FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [invitee],
    );
    expect(edges.rows).toHaveLength(1);
    expect(edges.rows[0]).toMatchObject({
      referrer_user_id: referrerId,
      code_id: codeId,
    });
  });

  it('serializes concurrent same-code attribution to one edge', async () => {
    const invitee = await createTestUser(pool, '15200006');
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const watcher = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const resultA = await attributeReferralCode(clientA, {
        referredUserId: invitee,
        code: CODE,
      });
      expect(resultA.outcome).toBe('ATTRIBUTED');

      const holderPid = (
        await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const pB = attributeReferralCode(clientB, { referredUserId: invitee, code: CODE });
      const blocked = await waitForBlockedOnHolder(watcher, holderPid);
      expect(blocked).toBe(true);

      await clientA.query('COMMIT');
      const resultB = await pB;
      await clientB.query('COMMIT');

      expect(resultB.outcome).toBe('ALREADY_ATTRIBUTED');
      const count = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM referral_edges WHERE referred_user_id = $1::uuid`,
        [invitee],
      );
      expect(count.rows[0]?.c).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
      watcher.release();
    }
  });

  it('serializes concurrent different-code attribution to one immutable winner', async () => {
    const invitee = await createTestUser(pool, '15200007');
    const other = await createTestUser(pool, '15200008');
    await insertReferralCode(pool, { userId: other, code: 'AltCode' });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const watcher = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const resultA = await attributeReferralCode(clientA, {
        referredUserId: invitee,
        code: CODE,
      });
      expect(resultA.outcome).toBe('ATTRIBUTED');
      if (resultA.outcome !== 'ATTRIBUTED') throw new Error('expected ATTRIBUTED');

      const holderPid = (
        await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const pB = attributeReferralCode(clientB, {
        referredUserId: invitee,
        code: 'AltCode',
      });
      const blocked = await waitForBlockedOnHolder(watcher, holderPid);
      expect(blocked).toBe(true);

      await clientA.query('COMMIT');
      const resultB = await pB;
      await clientB.query('COMMIT');

      expect(resultB.outcome).toBe('ALREADY_ATTRIBUTED');
      const edges = await pool.query<{ referrer_user_id: string; code_id: string }>(
        `SELECT referrer_user_id, code_id FROM referral_edges WHERE referred_user_id = $1::uuid`,
        [invitee],
      );
      expect(edges.rows).toHaveLength(1);
      expect(edges.rows[0]).toMatchObject({
        referrer_user_id: resultA.referrerUserId,
        code_id: resultA.codeId,
      });
    } finally {
      clientA.release();
      clientB.release();
      watcher.release();
    }
  });

  it('serializes attribution vs code disable (attribution first)', async () => {
    const invitee = await createTestUser(pool, '15200009');
    const attrClient = await pool.connect();
    const disableClient = await pool.connect();
    const watcher = await pool.connect();
    try {
      await attrClient.query('BEGIN');
      await disableClient.query('BEGIN');

      const attributed = await attributeReferralCode(attrClient, {
        referredUserId: invitee,
        code: CODE,
      });
      expect(attributed.outcome).toBe('ATTRIBUTED');

      const holderPid = (
        await attrClient.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const disablePromise = disableClient.query(
        `UPDATE referral_codes
         SET status = 'DISABLED'::activation_status
         WHERE id = $1::uuid`,
        [codeId],
      );
      const blocked = await waitForBlockedOnHolder(watcher, holderPid);
      expect(blocked).toBe(true);

      await attrClient.query('COMMIT');
      await disablePromise;
      await disableClient.query('COMMIT');

      const edgeCount = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM referral_edges WHERE referred_user_id = $1::uuid`,
        [invitee],
      );
      expect(edgeCount.rows[0]?.c).toBe(1);
      const status = await pool.query<{ status: string }>(
        `SELECT status::text AS status FROM referral_codes WHERE id = $1::uuid`,
        [codeId],
      );
      expect(status.rows[0]?.status).toBe('DISABLED');
    } finally {
      attrClient.release();
      disableClient.release();
      watcher.release();
    }
  });

  it('returns CODE_DISABLED when disable commits before attribution', async () => {
    const invitee = await createTestUser(pool, '15200010');
    await pool.query(
      `UPDATE referral_codes SET status = 'DISABLED'::activation_status WHERE id = $1::uuid`,
      [codeId],
    );
    const result = await withTx((client) =>
      attributeReferralCode(client, { referredUserId: invitee, code: CODE }),
    );
    expect(result).toEqual({ outcome: 'CODE_DISABLED' });
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM referral_edges WHERE referred_user_id = $1::uuid`,
      [invitee],
    );
    expect(count.rows[0]?.c).toBe(0);
  });
});
