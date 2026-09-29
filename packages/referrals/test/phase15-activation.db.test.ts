import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  CRITICAL_FRAUD_REJECTION_REASON,
  evaluateReferralActivation,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  getUsdtAssetId,
  grantFounderMembership,
  insertFraudFlag,
  insertPendingEdge,
  insertReferralCode,
  insertReferralRule,
  insertRewardEvent,
  phase15DatabaseUrl,
  resetAndMigrate,
  waitForBlockedOnHolder,
} from './harness.js';

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 evaluateReferralActivation', () => {
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
    referrerId = await createTestUser(pool, '15310001');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: 'ACTIVATE1' });
    await insertReferralRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      activationAccountAgeSeconds: 86_400,
      activationValidAdCount: 5,
      baseRateBps: 123,
    });
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

  async function makeInvitee(telegramId: string, ageSeconds: number): Promise<string> {
    const createdAt = new Date(Date.now() - ageSeconds * 1000);
    return createTestUser(pool, telegramId, { createdAt });
  }

  async function seedAvailableAds(userId: string, count: number): Promise<void> {
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

  it('keeps PENDING when account age is below threshold', async () => {
    const invitee = await makeInvitee('15310002', 3_600);
    await seedAvailableAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result).toMatchObject({
      outcome: 'STILL_PENDING',
      state: 'PENDING',
      reasons: ['ACCOUNT_AGE_PENDING'],
      requiredAccountAgeSeconds: 86_400,
      validAdCount: 5,
    });
  });

  it('keeps PENDING when valid ad count is below threshold', async () => {
    const invitee = await makeInvitee('15310003', 100_000);
    await seedAvailableAds(invitee, 4);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result).toMatchObject({
      outcome: 'STILL_PENDING',
      reasons: ['VALID_AD_COUNT_PENDING'],
      validAdCount: 4,
      requiredValidAdCount: 5,
    });
  });

  it('keeps PENDING when both age and ads are below threshold', async () => {
    const invitee = await makeInvitee('15310004', 10);
    await seedAvailableAds(invitee, 1);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result.outcome).toBe('STILL_PENDING');
    if (result.outcome !== 'STILL_PENDING') throw new Error('expected STILL_PENDING');
    expect(result.reasons).toEqual(['ACCOUNT_AGE_PENDING', 'VALID_AD_COUNT_PENDING']);
  });

  it('activates at exact age and ad thresholds and pins rule version', async () => {
    const invitee = await makeInvitee('15310005', 86_400);
    await seedAvailableAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result).toMatchObject({
      outcome: 'ACTIVATED',
      state: 'ACTIVE',
      activationRuleVersion: 1,
      requiredAccountAgeSeconds: 86_400,
      requiredValidAdCount: 5,
      validAdCount: 5,
    });
    const row = await pool.query<{
      state: string;
      activation_rule_version: number;
      activated_at: Date | null;
    }>(
      `SELECT state::text AS state, activation_rule_version, activated_at
       FROM referral_edges WHERE id = $1::uuid`,
      [edgeId],
    );
    expect(row.rows[0]).toMatchObject({
      state: 'ACTIVE',
      activation_rule_version: 1,
    });
    expect(row.rows[0]?.activated_at).toBeTruthy();
  });

  it('counts only AVAILABLE AD events; ignores PENDING/REVERSED/non-AD/duplicates by id', async () => {
    const invitee = await makeInvitee('15310006', 100_000);
    await seedAvailableAds(invitee, 4);
    await insertRewardEvent(pool, {
      userId: invitee,
      sourceId: randomUUID(),
      assetId,
      sourceType: 'AD',
      state: 'PENDING',
    });
    await insertRewardEvent(pool, {
      userId: invitee,
      sourceId: randomUUID(),
      assetId,
      sourceType: 'AD',
      state: 'REVERSED',
    });
    await insertRewardEvent(pool, {
      userId: invitee,
      sourceId: randomUUID(),
      assetId,
      sourceType: 'TASK',
      state: 'AVAILABLE',
    });
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const below = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(below).toMatchObject({
      outcome: 'STILL_PENDING',
      validAdCount: 4,
    });

    await seedAvailableAds(invitee, 1);
    const activated = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(activated).toMatchObject({
      outcome: 'ACTIVATED',
      validAdCount: 5,
    });
  });

  it('rejects OPEN CRITICAL fraud and pins activation rule version', async () => {
    const invitee = await makeInvitee('15310007', 100_000);
    await seedAvailableAds(invitee, 5);
    await insertFraudFlag(pool, { userId: invitee, severity: 'CRITICAL', status: 'OPEN' });
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result).toMatchObject({
      outcome: 'REJECTED',
      state: 'REJECTED',
      rejectionReason: CRITICAL_FRAUD_REJECTION_REASON,
      activationRuleVersion: 1,
    });
  });

  it('does not hard-reject CLOSED CRITICAL or HIGH-only flags', async () => {
    const invitee = await makeInvitee('15310008', 100_000);
    await seedAvailableAds(invitee, 5);
    await insertFraudFlag(pool, {
      userId: invitee,
      severity: 'CRITICAL',
      status: 'REVIEWED',
    });
    await insertFraudFlag(pool, { userId: invitee, severity: 'HIGH', status: 'OPEN' });
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result.outcome).toBe('ACTIVATED');
  });

  it('Founder membership cannot bypass OPEN CRITICAL fraud', async () => {
    const invitee = await makeInvitee('15310009', 100_000);
    await grantFounderMembership(pool, invitee);
    await seedAvailableAds(invitee, 5);
    await insertFraudFlag(pool, { userId: invitee, severity: 'CRITICAL', status: 'OPEN' });
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    const result = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(result.outcome).toBe('REJECTED');
  });

  it('retries are idempotent for ACTIVE and REJECTED', async () => {
    const invitee = await makeInvitee('15310010', 100_000);
    await seedAvailableAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    const again = await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    expect(again).toMatchObject({
      outcome: 'ALREADY_ACTIVE',
      state: 'ACTIVE',
      activationRuleVersion: 1,
    });

    const invitee2 = await makeInvitee('15310011', 100_000);
    await seedAvailableAds(invitee2, 5);
    await insertFraudFlag(pool, { userId: invitee2, severity: 'CRITICAL', status: 'OPEN' });
    const edge2 = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee2,
      codeId,
    });
    await withTx((c) => evaluateReferralActivation(c, { edgeId: edge2 }));
    const rejectedAgain = await withTx((c) => evaluateReferralActivation(c, { edgeId: edge2 }));
    expect(rejectedAgain.outcome).toBe('ALREADY_REJECTED');
  });

  it('serializes concurrent activation to one transition', async () => {
    const invitee = await makeInvitee('15310012', 100_000);
    await seedAvailableAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const watcher = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      const first = await evaluateReferralActivation(clientA, { edgeId });
      expect(first.outcome).toBe('ACTIVATED');
      const holderPid = (
        await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      const pB = evaluateReferralActivation(clientB, { edgeId });
      expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);
      await clientA.query('COMMIT');
      const second = await pB;
      await clientB.query('COMMIT');
      expect(second.outcome).toBe('ALREADY_ACTIVE');
    } finally {
      clientA.release();
      clientB.release();
      watcher.release();
    }
  });

  it('writes no ledger transactions during activation', async () => {
    const before = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions`,
    );
    const invitee = await makeInvitee('15310013', 100_000);
    await seedAvailableAds(invitee, 5);
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: invitee,
      codeId,
    });
    await withTx((c) => evaluateReferralActivation(c, { edgeId }));
    const after = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions`,
    );
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });
});
