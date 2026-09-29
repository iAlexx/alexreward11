/**
 * Phase 16 Step 7 — mission runtime e2e (progress → claim → issuance → maturity)
 * plus concurrency / policy races. Destructive against PHASE16 / PHASE15 DB URL.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  contributeMissionProgress,
  prepareMissionClaim,
  processDailyLoginMissionContributionsBatch,
} from '@alex-rewards/tasks';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createExposureLimitVersion,
  createRewardBudgetPeriod,
  createRewardRuleVersion,
  issueMissionReward,
  processDueMissionRewardMaturityBatch,
  processPendingMissionRewardClaimsBatch,
  withLedgerTransaction,
} from '../src/index.js';
import { utcDayContaining } from '../src/budget-windows.js';
import {
  createTestUser,
  phase5DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
} from './harness.js';

const phase16Url =
  process.env.PHASE16_DATABASE_URL !== undefined && process.env.PHASE16_DATABASE_URL !== ''
    ? process.env.PHASE16_DATABASE_URL
    : process.env.PHASE15_DATABASE_URL !== undefined && process.env.PHASE15_DATABASE_URL !== ''
      ? process.env.PHASE15_DATABASE_URL
      : phase5DatabaseUrl;

const AMOUNT = '1000';

async function seedEligibilityPolicy(pool: Pool, version: number): Promise<void> {
  await pool.query(
    `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`,
  );
  await pool.query(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, reason, policy_config
     ) VALUES (
       $1, 'ACTIVE', now() - interval '1 day', 'phase16-step7-e2e', $2::jsonb
     )`,
    [
      version,
      JSON.stringify({
        actions: {
          MISSION_CLAIM: {
            requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG', 'MEMBERSHIP', 'COUNTRY_POLICY'],
            precedence: ['ACCOUNT_STATE', 'MEMBERSHIP', 'COUNTRY_POLICY', 'FEATURE_FLAG'],
          },
        },
      }),
    ],
  );
}

async function insertSession(pool: Pool, userId: string, createdAt: Date): Promise<void> {
  const secret = createHash('sha256').update(randomBytes(32)).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (
       user_id, session_secret_hash, expires_at, created_at, last_seen_at
     ) VALUES (
       $1::uuid, $2, $3::timestamptz, $4::timestamptz, $4::timestamptz
     )`,
    [
      userId,
      `sess_${secret}`,
      new Date(createdAt.getTime() + 86_400_000).toISOString(),
      createdAt.toISOString(),
    ],
  );
}

describe.skipIf(phase16Url === '')('Phase 16 Step 7 mission runtime e2e (DB)', () => {
  let pool: Pool;
  let assetId: string;
  let policyVersion = 1700;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase16Url);
    pool = new Pool({ connectionString: phase16Url, max: 16 });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        outbox_events,
        mission_reward_decisions,
        mission_reward_budget_reservations,
        mission_bonus_exposure_reservations,
        mission_claim_events,
        mission_claims,
        mission_progress_events,
        mission_progress,
        mission_versions,
        mission_definitions,
        eligibility_decisions,
        eligibility_policy_versions,
        reward_maturities,
        economic_exposure_reservations,
        economic_exposure_periods,
        economic_exposure_limits,
        reward_events,
        reward_quotes,
        reward_budget_reservations,
        reward_budget_periods,
        reward_rules,
        ledger_entries,
        ledger_account_balances,
        ledger_transactions,
        ledger_accounts,
        user_sessions,
        user_memberships,
        membership_plan_entitlements,
        membership_benefit_rule_versions,
        users
      RESTART IDENTITY CASCADE
    `);
    await seedEligibilityPolicy(pool, policyVersion++);
    await pool.query(
      `UPDATE feature_flags SET enabled = false
       WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
    );
    seq += 1;
  });

  async function seedMissionBudget(missionVersionId: string, budgetAtomic: bigint): Promise<void> {
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: budgetAtomic.toString(10),
      });
    });
  }

  async function seedDailyMissionExposure(limitAtomic: bigint): Promise<void> {
    const ruleVersion = Date.now() % 1_000_000_000 + seq;
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: limitAtomic.toString(10),
        ruleVersion,
        activate: true,
        reason: 'phase16-step7-e2e',
      });
    });
  }

  async function createMonetaryDailyLoginMission(input?: {
    readonly amountAtomic?: string;
    readonly pendingHoldSeconds?: number;
    readonly requiredMembershipPlanId?: string | null;
  }): Promise<{
    userId: string;
    missionVersionId: string;
    rewardRuleId: string;
    defId: string;
  }> {
    const userId = await createTestUser(pool, String(17_000_000 + seq * 100 + (Date.now() % 1000)));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-e2e-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: input?.amountAtomic ?? AMOUNT,
        pendingHoldSeconds: input?.pendingHoldSeconds ?? 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-step7-e2e',
      }),
    );
    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16S7_${randomUUID().slice(0, 8)}`, 'mission.e2e'],
    );
    const defId = def.rows[0]!.id;
    const ver = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, status, start_at, end_at, reward_source_type, reward_rule_id,
         required_membership_plan_id
       ) VALUES (
         $1::uuid, 1, 'mission.e2e', 'DAILY_LOGIN'::mission_condition_type, 1,
         'DAILY'::mission_reset_policy, 'ACTIVE', now() - interval '1 day', NULL,
         'MISSION'::reward_source_type, $2::uuid, $3::uuid
       ) RETURNING id`,
      [defId, rule.id, input?.requiredMembershipPlanId ?? null],
    );
    return {
      userId,
      missionVersionId: ver.rows[0]!.id,
      rewardRuleId: rule.id,
      defId,
    };
  }

  it('zero missions: producer/claim/maturity batches are safe no-ops', async () => {
    const daily = await processDailyLoginMissionContributionsBatch(pool, { limit: 10 });
    const claims = await processPendingMissionRewardClaimsBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    const maturity = await processDueMissionRewardMaturityBatch(pool, { limit: 10 });
    expect(daily.examined).toBe(0);
    expect(claims.scanned).toBe(0);
    expect(maturity.scanned).toBe(0);
  });

  it('e2e daily login: session → producer → claim → issuance → maturity (no duplicate)', async () => {
    const created = await createMonetaryDailyLoginMission({ pendingHoldSeconds: 0 });
    await seedMissionBudget(created.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(1_000_000n);

    const loginAt = new Date();
    await insertSession(pool, created.userId, loginAt);

    const progressBatch = await processDailyLoginMissionContributionsBatch(pool, { limit: 20 });
    expect(progressBatch.examined).toBeGreaterThanOrEqual(1);

    const progress = await pool.query<{ id: string; state: string; progress_count: number }>(
      `SELECT id, state::text AS state, progress_count
       FROM mission_progress
       WHERE user_id = $1::uuid AND mission_version_id = $2::uuid`,
      [created.userId, created.missionVersionId],
    );
    expect(progress.rows).toHaveLength(1);
    expect(progress.rows[0]?.state).toBe('COMPLETED');
    expect(progress.rows[0]?.progress_count).toBe(1);

    // Same-day replay: no second contribution / no second progress row.
    await insertSession(pool, created.userId, loginAt);
    await processDailyLoginMissionContributionsBatch(pool, { limit: 20 });
    const progressAfter = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_progress
       WHERE user_id = $1::uuid AND mission_version_id = $2::uuid`,
      [created.userId, created.missionVersionId],
    );
    expect(progressAfter.rows[0]?.c).toBe(1);

    const prepared = await prepareMissionClaim(pool, {
      userId: created.userId,
      missionProgressId: progress.rows[0]!.id,
      deploymentEnvironment: 'LOCAL',
    });
    expect(prepared.outcome).toBe('CLAIM_PENDING');

    const issuance = await processPendingMissionRewardClaimsBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    const issued = issuance.items.find((i) => i.ok && i.missionClaimId === prepared.claimId);
    expect(issued?.ok).toBe(true);
    if (issued === undefined || !issued.ok) throw new Error('issuance missing');
    expect(issued.result.kind).toBe('issued');

    const maturity = await processDueMissionRewardMaturityBatch(pool, { limit: 10 });
    const matured = maturity.items.find(
      (i) => i.ok && i.rewardEventId === issued.result.rewardEventId,
    );
    expect(matured?.ok).toBe(true);

    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [issued.result.rewardEventId],
    );
    expect(state.rows[0]?.state).toBe('AVAILABLE');

    const retryIssuance = await processPendingMissionRewardClaimsBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(retryIssuance.scanned).toBe(0);

    const rewards = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM reward_events WHERE source_type = 'MISSION'`,
    );
    expect(rewards.rows[0]?.c).toBe(1);

    const taskLedger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions
       WHERE transaction_type = 'TASK_REWARD_ISSUANCE'`,
    );
    expect(taskLedger.rows[0]?.c).toBe(0);
  });

  it('claim race: concurrent prepareMissionClaim yields one claim identity', async () => {
    const created = await createMonetaryDailyLoginMission();
    const client = await pool.connect();
    let progressId: string;
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: created.missionVersionId,
        userId: created.userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:${randomUUID()}`,
        occurredAt: new Date(),
      });
      if (contributed.outcome !== 'CONTRIBUTED') throw new Error('contribute failed');
      progressId = contributed.progressId;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const results = await Promise.all([
      prepareMissionClaim(pool, {
        userId: created.userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
      prepareMissionClaim(pool, {
        userId: created.userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      }),
    ]);
    const claimIds = new Set(results.map((r) => r.claimId).filter(Boolean));
    expect(claimIds.size).toBe(1);
    const claims = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claims WHERE mission_progress_id = $1`,
      [progressId],
    );
    expect(claims.rows[0]?.c).toBe(1);
  });

  it('budget race: exactly one of two claims spends remaining capacity', async () => {
    const a = await createMonetaryDailyLoginMission({ amountAtomic: '1000' });
    const b = await createMonetaryDailyLoginMission({ amountAtomic: '1000' });
    // Shared exposure limit: only one reward of 1000 fits.
    await seedDailyMissionExposure(1000n);
    await seedMissionBudget(a.missionVersionId, 1_000_000n);
    await seedMissionBudget(b.missionVersionId, 1_000_000n);

    async function completeClaim(userId: string, missionVersionId: string): Promise<string> {
      const client = await pool.connect();
      let progressId: string;
      try {
        await client.query('BEGIN');
        const contributed = await contributeMissionProgress(client, {
          missionVersionId,
          userId,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: `DAY:${randomUUID()}`,
          occurredAt: new Date(),
        });
        if (contributed.outcome !== 'CONTRIBUTED') throw new Error('contribute failed');
        progressId = contributed.progressId;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const prepared = await prepareMissionClaim(pool, {
        userId,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      });
      expect(prepared.outcome).toBe('CLAIM_PENDING');
      return prepared.claimId!;
    }

    const claimA = await completeClaim(a.userId, a.missionVersionId);
    const claimB = await completeClaim(b.userId, b.missionVersionId);

    const races = await Promise.all([
      issueMissionReward(pool, { missionClaimId: claimA, environment: 'LOCAL' }),
      issueMissionReward(pool, { missionClaimId: claimB, environment: 'LOCAL' }),
    ]);
    const issued = races.filter((r) => r.kind === 'issued');
    const blocked = races.filter(
      (r) => r.kind === 'blocked_exposure' || r.kind === 'blocked_budget',
    );
    expect(issued).toHaveLength(1);
    expect(blocked).toHaveLength(1);

    const granted = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claims WHERE status = 'GRANTED'`,
    );
    expect(granted.rows[0]?.c).toBe(1);
    const pending = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claims WHERE status = 'PENDING'`,
    );
    expect(pending.rows[0]?.c).toBe(1);
  });

  // Pause / membership / rule-lifecycle issuance races: see
  // packages/rewards/test/phase16-mission-concurrency.db.test.ts (deterministic two-client locks).

  it('post-grant AD reversal does not cascade mission money (OWNER_POLICY_REQUIRED)', async () => {
    const created = await createMonetaryDailyLoginMission({ pendingHoldSeconds: 0 });
    await seedMissionBudget(created.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(1_000_000n);

    const client = await pool.connect();
    let progressId: string;
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: created.missionVersionId,
        userId: created.userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:${randomUUID()}`,
        occurredAt: new Date(),
      });
      if (contributed.outcome !== 'CONTRIBUTED') throw new Error('contribute failed');
      progressId = contributed.progressId;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const prepared = await prepareMissionClaim(pool, {
      userId: created.userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    const issued = await issueMissionReward(pool, {
      missionClaimId: prepared.claimId!,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    // Simulate unrelated AD reversal after grant — mission reward must remain.
    const ad = await pool.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state, available_at
       ) VALUES (
         $1::uuid, 'AD', $2::uuid, $3::uuid, 100, 'AVAILABLE', now()
       ) RETURNING id`,
      [created.userId, randomUUID(), assetId],
    );
    await pool.query(
      `UPDATE reward_events SET state = 'REVERSED' WHERE id = $1::uuid`,
      [ad.rows[0]!.id],
    );

    const missionState = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [issued.rewardEventId],
    );
    expect(missionState.rows[0]?.state).toBe('PENDING');
    const claim = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM mission_claims WHERE id = $1`,
      [prepared.claimId],
    );
    expect(claim.rows[0]?.status).toBe('GRANTED');
  });
});
