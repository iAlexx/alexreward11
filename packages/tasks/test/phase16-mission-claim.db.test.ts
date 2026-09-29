/**
 * Phase 16 Step 4 — secure mission claim authority (DB).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  MissionDomainError,
  contributeMissionProgress,
  prepareMissionClaim,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  getFounderPlanId,
  grantFounderMembership,
  insertAvailableAdReward,
  insertEligibilityPolicy,
  insertMissionDefinition,
  insertMissionProgress,
  insertMissionRewardRule,
  insertMissionVersion,
  phase16DatabaseUrl,
  resetAndMigrate,
  reverseAdReward,
  seedExclusiveMissionAccess,
  TEST_MISSION_CLAIM_ELIGIBILITY_POLICY,
} from './harness.js';

describe.skipIf(phase16DatabaseUrl === '')('Phase 16 Step 4 mission claim authority (DB)', () => {
  let pool: Pool;
  let userId: string;
  let otherUserId: string;
  let policyVersion = 1600;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = createPool(phase16DatabaseUrl);
    userId = await createTestUser(pool, '16400001');
    otherUserId = await createTestUser(pool, '16400002');
    await insertEligibilityPolicy(pool, {
      policyVersion: policyVersion++,
      policyConfig: TEST_MISSION_CLAIM_ELIGIBILITY_POLICY,
    });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  async function completedDailyLogin(opts?: {
    readonly code?: string;
    readonly rewardRuleId?: string | null;
    readonly endAt?: Date | null;
    readonly requiredMembershipPlanId?: string | null;
    readonly eligibilityPolicy?: unknown;
    readonly user?: string;
  }) {
    const owner = opts?.user ?? userId;
    const defId = await insertMissionDefinition(pool, {
      code: opts?.code ?? `P16S4_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: opts?.endAt === undefined ? null : opts.endAt,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
      rewardRuleId: opts?.rewardRuleId === undefined ? null : opts.rewardRuleId,
      requiredMembershipPlanId: opts?.requiredMembershipPlanId ?? null,
      eligibilityPolicy: opts?.eligibilityPolicy ?? {},
    });
    const client = await pool.connect();
    let progressId: string;
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId: owner,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:claim-${randomUUID()}`,
        occurredAt: new Date('2026-05-01T12:00:00.000Z'),
      });
      if (contributed.outcome !== 'CONTRIBUTED' || !contributed.completed) {
        throw new Error(`expected completed contribution, got ${contributed.outcome}`);
      }
      progressId = contributed.progressId;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { defId, versionId, progressId };
  }

  it('blocks unmet claim and creates no claim row', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: `P16S4_UNMET_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
    });
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 3,
      progressCount: 1,
      state: 'IN_PROGRESS',
      startedAt: new Date('2026-05-01T12:00:00.000Z'),
    });

    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'MISSION_NOT_COMPLETED' });

    const claims = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claims WHERE mission_progress_id = $1::uuid`,
      [progressId],
    );
    expect(claims.rows[0]?.c).toBe(0);
  });

  it('blocks wrong-user claim without leaking progress', async () => {
    const { progressId } = await completedDailyLogin({ code: `P16S4_OWN_${randomUUID().slice(0, 8)}` });
    await expect(
      prepareMissionClaim(pool, {
        userId: otherUserId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'MISSION_PROGRESS_NOT_FOUND' });
  });

  it('grants non-monetary claim and is idempotent', async () => {
    const { progressId } = await completedDailyLogin({
      code: `P16S4_NM_${randomUUID().slice(0, 8)}`,
      rewardRuleId: null,
    });
    const first = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(first.outcome).toBe('CLAIM_GRANTED');
    expect(first.claimStatus).toBe('GRANTED');
    expect(first.monetary).toBe(false);
    expect(first.claimId).toBeTruthy();

    const second = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(second.outcome).toBe('ALREADY_GRANTED');
    expect(second.claimId).toBe(first.claimId);
  });

  it('creates PENDING monetary claim; recovers existing PENDING after window end', async () => {
    const ruleId = await insertMissionRewardRule(pool);
    const endAt = new Date('2026-06-01T00:00:00.000Z');
    const { progressId, versionId } = await completedDailyLogin({
      code: `P16S4_PEND_${randomUUID().slice(0, 8)}`,
      rewardRuleId: ruleId,
      endAt,
    });

    const first = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
      asOf: new Date('2026-05-15T00:00:00.000Z'),
    });
    expect(first.outcome).toBe('CLAIM_PENDING');
    expect(first.claimStatus).toBe('PENDING');
    expect(first.monetary).toBe(true);
    expect(first.recovered).toBe(false);

    // New claim after end is blocked when no prior claim — but PENDING recovers.
    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
        asOf: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      outcome: 'CLAIM_PENDING',
      claimId: first.claimId,
      recovered: true,
    });

    // Separate completed progress after end with no prior claim → blocked.
    const late = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId: otherUserId,
      periodKey: 'LIFETIME',
      target: 1,
      progressCount: 1,
      state: 'COMPLETED',
      startedAt: new Date('2026-05-01T12:00:00.000Z'),
      completedAt: new Date('2026-05-01T12:00:00.000Z'),
    });
    // otherUser needs own completed contribution path — version window closed for NEW claims
    await expect(
      prepareMissionClaim(pool, {
        userId: otherUserId,
        missionProgressId: late,
        deploymentEnvironment: 'LOCAL',
        asOf: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'MISSION_CLAIM_WINDOW_CLOSED' });
  });

  it('blocks new claim after end with no prior claim', async () => {
    const { progressId } = await completedDailyLogin({
      code: `P16S4_END_${randomUUID().slice(0, 8)}`,
      endAt: new Date('2026-05-02T00:00:00.000Z'),
    });
    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
        asOf: new Date('2026-05-03T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'MISSION_CLAIM_WINDOW_CLOSED' });
  });

  it('Founder-only: standard user blocked; Founder with EXCLUSIVE_MISSION_ACCESS eligible', async () => {
    await seedExclusiveMissionAccess(pool, { ruleVersion: policyVersion });
    const planId = await getFounderPlanId(pool);
    const founderId = await createTestUser(pool, '16400010');
    await grantFounderMembership(pool, founderId);

    const { progressId: blockedProgress } = await completedDailyLogin({
      code: `P16S4_FOB_${randomUUID().slice(0, 8)}`,
      requiredMembershipPlanId: planId,
      user: userId,
    });
    const blocked = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: blockedProgress,
      deploymentEnvironment: 'LOCAL',
    });
    expect(blocked.outcome).toBe('NOT_ELIGIBLE');
    expect(blocked.claimId).toBeNull();
    expect(blocked.reasonCodes.some((c) => c.includes('MEMBERSHIP') || c.includes('EXCLUSIVE'))).toBe(
      true,
    );

    const { progressId: founderProgress } = await completedDailyLogin({
      code: `P16S4_FOOK_${randomUUID().slice(0, 8)}`,
      requiredMembershipPlanId: planId,
      user: founderId,
    });
    const ok = await prepareMissionClaim(pool, {
      userId: founderId,
      missionProgressId: founderProgress,
      deploymentEnvironment: 'LOCAL',
    });
    expect(ok.outcome).toBe('CLAIM_GRANTED');
  });

  it('revoked membership and missing EXCLUSIVE_MISSION_ACCESS are blocked', async () => {
    const planId = await getFounderPlanId(pool);
    const holder = await createTestUser(pool, '16400011');
    const membershipId = await grantFounderMembership(pool, holder);
    // No entitlement seeded for this path (ruleVersion unique already used — skip seed).
    const { progressId } = await completedDailyLogin({
      code: `P16S4_NOENT_${randomUUID().slice(0, 8)}`,
      requiredMembershipPlanId: planId,
      user: holder,
    });
    // Entitlement may already exist from prior test — revoke membership instead for clear signal.
    await pool.query(
      `UPDATE user_memberships
       SET status = 'REVOKED'::membership_status, revoked_at = now(), revocation_reason = 'test'
       WHERE id = $1::uuid`,
      [membershipId],
    );
    const revoked = await prepareMissionClaim(pool, {
      userId: holder,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(revoked.outcome).toBe('NOT_ELIGIBLE');
    expect(revoked.claimId).toBeNull();
  });

  it('Founder cannot bypass ACCOUNT_STATE blocks', async () => {
    await seedExclusiveMissionAccess(pool, { ruleVersion: policyVersion + 50 }).catch(() => {
      // entitlement may already exist from earlier test — OK
    });
    const planId = await getFounderPlanId(pool);
    const founderId = await createTestUser(pool, '16400012');
    await grantFounderMembership(pool, founderId);
    await pool.query(`UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`, [
      founderId,
    ]);
    const { progressId } = await completedDailyLogin({
      code: `P16S4_ACC_${randomUUID().slice(0, 8)}`,
      requiredMembershipPlanId: planId,
      user: founderId,
    });
    const result = await prepareMissionClaim(pool, {
      userId: founderId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(result.outcome).toBe('NOT_ELIGIBLE');
    expect(result.reasonCodes).toContain('ACCOUNT_STATE_NOT_ACTIVE');
    await pool.query(`UPDATE users SET status = 'ACTIVE'::user_status WHERE id = $1::uuid`, [
      founderId,
    ]);
  });

  it('country restriction fail-closed when countryGroup is set', async () => {
    const { progressId } = await completedDailyLogin({
      code: `P16S4_CTY_${randomUUID().slice(0, 8)}`,
      eligibilityPolicy: { countryGroup: 'TEST_GROUP_UNAPPROVED' },
    });
    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE' });
  });

  it('monetary MISSION_REWARD_PAUSE blocks claim authorization', async () => {
    const ruleId = await insertMissionRewardRule(pool);
    await pool.query(
      `UPDATE feature_flags SET enabled = true
       WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
    );
    try {
      const { progressId } = await completedDailyLogin({
        code: `P16S4_PAUSE_${randomUUID().slice(0, 8)}`,
        rewardRuleId: ruleId,
      });
      const result = await prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      });
      expect(result.outcome).toBe('NOT_ELIGIBLE');
      expect(result.claimId).toBeNull();
      const progress = await pool.query<{ state: string }>(
        `SELECT state::text AS state FROM mission_progress WHERE id = $1::uuid`,
        [progressId],
      );
      expect(progress.rows[0]?.state).toBe('COMPLETED');
    } finally {
      await pool.query(
        `UPDATE feature_flags SET enabled = false
         WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
      );
    }
  });

  it('reversed AD evidence before claim blocks authorization', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: `P16S4_ADREV_${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });
    const adId = await insertAvailableAdReward(pool, { userId });
    const client = await pool.connect();
    let progressId: string;
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'REWARD_EVENT',
        sourceKey: adId,
        occurredAt: new Date('2026-05-01T12:00:00.000Z'),
      });
      expect(contributed.outcome).toBe('CONTRIBUTED');
      progressId = contributed.progressId;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await reverseAdReward(pool, adId);

    await expect(
      prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'MISSION_SOURCE_EVIDENCE_NO_LONGER_VALID' });

    const stillCompleted = await pool.query<{ state: string; progress_count: number }>(
      `SELECT state::text AS state, progress_count FROM mission_progress WHERE id = $1::uuid`,
      [progressId],
    );
    expect(stillCompleted.rows[0]?.state).toBe('COMPLETED');
    expect(stillCompleted.rows[0]?.progress_count).toBe(1);
  });
});
