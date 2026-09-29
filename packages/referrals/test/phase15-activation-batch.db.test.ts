/**
 * Phase 15 remediation — activation batch worker path.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { processPendingReferralActivationBatch } from '../src/index.js';
import {
  createPool,
  createTestUser,
  getUsdtAssetId,
  insertPendingEdge,
  insertReferralCode,
  insertReferralRule,
  insertRewardEvent,
  phase15DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 processPendingReferralActivationBatch', () => {
  let pool: Pool;
  let assetId: string;
  let referrerId: string;
  let codeId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
    assetId = await getUsdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        referral_reward_events, referral_edges, referral_codes, referral_rule_versions,
        fraud_flags, reward_events, user_memberships, users
      RESTART IDENTITY CASCADE
    `);
    referrerId = await createTestUser(pool, '15410001');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: 'BATCHACT1' });
  });

  async function seedAds(userId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await insertRewardEvent(pool, {
        userId,
        sourceId: randomUUID(),
        assetId,
        sourceType: 'AD',
        state: 'AVAILABLE',
      });
    }
  }

  it('reports REFERRAL_RULE_NOT_CONFIGURED without mutating edges', async () => {
    const invitee = await createTestUser(pool, '15410002', {
      createdAt: new Date(Date.now() - 200_000_000),
    });
    await seedAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const batch = await processPendingReferralActivationBatch(pool, { limit: 10 });
    expect(batch.scanned).toBe(1);
    expect(batch.items[0]).toMatchObject({
      edgeId,
      ok: false,
      reasonCode: 'REFERRAL_RULE_NOT_CONFIGURED',
    });
    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM referral_edges WHERE id = $1`,
      [edgeId],
    );
    expect(state.rows[0]?.state).toBe('PENDING');
  });

  it('age insufficient then advance created_at then batch activates without new ads', async () => {
    await insertReferralRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      activationAccountAgeSeconds: 86_400,
      activationValidAdCount: 5,
      baseRateBps: 123,
    });
    const invitee = await createTestUser(pool, '15410003', {
      createdAt: new Date(Date.now() - 3_600_000),
    });
    await seedAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });

    const first = await processPendingReferralActivationBatch(pool, { limit: 10 });
    expect(first.items[0]).toMatchObject({
      edgeId,
      ok: true,
      outcome: { outcome: 'STILL_PENDING' },
    });

    const adsBefore = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM reward_events WHERE user_id = $1 AND source_type = 'AD'`,
      [invitee],
    );

    await pool.query(`UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, [
      invitee,
    ]);

    const second = await processPendingReferralActivationBatch(pool, { limit: 10 });
    expect(second.items[0]).toMatchObject({
      edgeId,
      ok: true,
      outcome: { outcome: 'ACTIVATED', state: 'ACTIVE' },
    });

    const adsAfter = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM reward_events WHERE user_id = $1 AND source_type = 'AD'`,
      [invitee],
    );
    expect(adsAfter.rows[0]?.c).toBe(adsBefore.rows[0]?.c);
  });
});
