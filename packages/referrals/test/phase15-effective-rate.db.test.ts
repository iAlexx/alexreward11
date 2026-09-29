import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  ReferralDomainError,
  resolveEffectiveReferralRate,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  getUsdtAssetId,
  grantFounderMembership,
  insertReferralRule,
  phase15DatabaseUrl,
  resetAndMigrate,
  seedReferralRateBoost,
} from './harness.js';

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 resolveEffectiveReferralRate', () => {
  let pool: Pool;
  let assetId: string;

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
        membership_plan_entitlements, membership_benefit_rule_versions,
        user_memberships, users
      RESTART IDENTITY CASCADE
    `);
    await insertReferralRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      baseRateBps: 123,
      activationAccountAgeSeconds: 0,
      activationValidAdCount: 0,
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

  it('uses base referral rule rate with no membership', async () => {
    const userId = await createTestUser(pool, '15400001');
    const resolved = await withTx((c) =>
      resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
    );
    expect(resolved).toMatchObject({
      effectiveRateBps: 123,
      baseRateBps: 123,
      referralRuleVersion: 1,
      rateSource: 'BASE_RULE',
      userMembershipId: null,
      entitlementRuleVersionId: null,
    });
  });

  it('Founder membership alone without entitlement uses base rate', async () => {
    const userId = await createTestUser(pool, '15400002');
    await grantFounderMembership(pool, userId);
    const resolved = await withTx((c) =>
      resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
    );
    expect(resolved.rateSource).toBe('BASE_RULE');
    expect(resolved.effectiveRateBps).toBe(123);
  });

  it('valid FINANCIAL BPS entitlement replaces base rate (not additive)', async () => {
    const userId = await createTestUser(pool, '15400003');
    await grantFounderMembership(pool, userId);
    const seeded = await seedReferralRateBoost(pool, { valueBps: 777 });
    const resolved = await withTx((c) =>
      resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
    );
    expect(resolved).toMatchObject({
      effectiveRateBps: 777,
      baseRateBps: 123,
      rateSource: 'MEMBERSHIP_PROFILE',
      entitlementRuleVersionId: seeded.ruleVersionId,
    });
    expect(resolved.effectiveRateBps).not.toBe(123 + 777);
    expect(resolved.userMembershipId).toBeTruthy();
  });

  it('expired or revoked membership falls back to base rate', async () => {
    const expiredUser = await createTestUser(pool, '15400004');
    const membershipId = await grantFounderMembership(pool, expiredUser);
    await seedReferralRateBoost(pool, { valueBps: 321, ruleVersion: 1 });
    await pool.query(
      `UPDATE user_memberships
       SET status = 'EXPIRED'::membership_status, expires_at = now() - interval '1 day'
       WHERE id = $1::uuid`,
      [membershipId],
    );
    expect(
      await withTx((c) =>
        resolveEffectiveReferralRate(c, { referrerUserId: expiredUser, assetId }),
      ),
    ).toMatchObject({ rateSource: 'BASE_RULE', effectiveRateBps: 123 });

    const revokedUser = await createTestUser(pool, '15400005');
    const revokedMembership = await grantFounderMembership(pool, revokedUser);
    await pool.query(
      `UPDATE user_memberships
       SET status = 'REVOKED'::membership_status,
           revoked_at = now(),
           revocation_reason = 'test'
       WHERE id = $1::uuid`,
      [revokedMembership],
    );
    expect(
      await withTx((c) =>
        resolveEffectiveReferralRate(c, { referrerUserId: revokedUser, assetId }),
      ),
    ).toMatchObject({ rateSource: 'BASE_RULE', effectiveRateBps: 123 });
  });

  it('fails closed on ambiguous valid entitlements', async () => {
    const userId = await createTestUser(pool, '15400006');
    await grantFounderMembership(pool, userId);
    await seedReferralRateBoost(pool, { valueBps: 321, ruleVersion: 1, assetId: null });
    // Second ACTIVE plan-scoped entitlement on STANDARD plan for same user would need
    // another membership. Instead insert a second FOUNDER binding via global plan NULL
    // rule that still matches — use STANDARD membership + second boost.
    const standard = await pool.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
    );
    await pool.query(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, status, source, claimed_at
       ) VALUES (
         $1::uuid, $2::uuid, 'ACTIVE'::membership_status, 'OWNER_GRANT', now()
       )`,
      [userId, standard.rows[0]!.id],
    );
    await seedReferralRateBoost(pool, {
      valueBps: 777,
      ruleVersion: 1,
      planCode: 'STANDARD',
    });

    await expect(
      withTx((c) => resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId })),
    ).rejects.toBeInstanceOf(ReferralDomainError);
    await expect(
      withTx((c) => resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId })),
    ).rejects.toMatchObject({ code: 'REFERRAL_ENTITLEMENT_AMBIGUOUS' });
  });

  it('asset-specific matching prefers exact asset; wrong asset falls back', async () => {
    const userId = await createTestUser(pool, '15400007');
    await grantFounderMembership(pool, userId);
    const otherAsset = await pool.query<{ id: string }>(
      `SELECT id FROM assets WHERE symbol <> 'USDT' LIMIT 1`,
    );
    if (otherAsset.rows[0] === undefined) {
      // Only USDT in fixtures — seed asset-scoped USDT rule and verify it matches.
      await seedReferralRateBoost(pool, { valueBps: 321, assetId });
      const resolved = await withTx((c) =>
        resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
      );
      expect(resolved.effectiveRateBps).toBe(321);
      return;
    }
    await seedReferralRateBoost(pool, {
      valueBps: 321,
      assetId: otherAsset.rows[0].id,
    });
    const resolved = await withTx((c) =>
      resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
    );
    expect(resolved).toMatchObject({ rateSource: 'BASE_RULE', effectiveRateBps: 123 });
  });

  it('does not hardcode 500/700 and writes no ledger rows', async () => {
    const before = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions`,
    );
    const userId = await createTestUser(pool, '15400008');
    await grantFounderMembership(pool, userId);
    await seedReferralRateBoost(pool, { valueBps: 777 });
    const resolved = await withTx((c) =>
      resolveEffectiveReferralRate(c, { referrerUserId: userId, assetId }),
    );
    expect(resolved.effectiveRateBps).toBe(777);
    expect(resolved.baseRateBps).toBe(123);
    expect([500, 700]).not.toContain(resolved.effectiveRateBps);
    expect([500, 700]).not.toContain(resolved.baseRateBps);
    const after = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions`,
    );
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });
});
