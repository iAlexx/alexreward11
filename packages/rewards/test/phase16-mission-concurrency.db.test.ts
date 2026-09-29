/**
 * Phase 16 MEGA remediation — deterministic issuance concurrency (DB).
 */
import { randomUUID } from 'node:crypto';

import {
  contributeMissionProgress,
  prepareMissionClaim,
  processValidAdMissionContributionsBatch,
} from '@alex-rewards/tasks';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createExposureLimitVersion,
  createRewardBudgetPeriod,
  createRewardRuleVersion,
  issueMissionReward,
  issueMissionRewardOnClient,
  withLedgerTransaction,
} from '../src/index.js';
import { utcDayContaining } from '../src/budget-windows.js';
import {
  createTestUser,
  phase5DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
  waitForBlockedOnHolder,
  waitForHolderGrantedRelation,
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
       $1, 'ACTIVE', now() - interval '1 day', 'phase16-concurrency', $2::jsonb
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

describe.skipIf(phase16Url === '')('Phase 16 mission issuance concurrency (DB)', () => {
  let pool: Pool;
  let assetId: string;
  let policyVersion = 1800;
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
        mission_reward_decision_exposure_periods,
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

  async function seedDualExposure(missionVersionId: string): Promise<void> {
    const ruleVersionBase = Date.now() % 1_000_000_000 + seq;
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: AMOUNT,
        ruleVersion: ruleVersionBase,
        activate: true,
        reason: 'phase16-concurrency-global',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        scopeReferenceId: missionVersionId,
        limitAtomic: AMOUNT,
        ruleVersion: ruleVersionBase + 1,
        activate: true,
        reason: 'phase16-concurrency-mission',
      });
    });
  }

  async function insertAvailableAdReward(userId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state, available_at
       ) VALUES (
         $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, 100,
         'AVAILABLE'::reward_event_state, now()
       ) RETURNING id`,
      [userId, randomUUID(), assetId],
    );
    return result.rows[0]!.id;
  }

  async function seedMissionBudget(missionVersionId: string, budgetAtomic: string): Promise<void> {
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic,
      });
    });
  }

  async function seedGlobalMissionExposure(limitAtomic: string): Promise<void> {
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic,
        ruleVersion: Date.now() % 1_000_000_000 + seq,
        activate: true,
        reason: 'phase16-concurrency',
      });
    });
  }

  async function createDailyLoginPendingClaim(input?: {
    readonly amountAtomic?: string;
    readonly requiredMembershipPlanId?: string | null;
    readonly conditionType?: 'DAILY_LOGIN' | 'VALID_AD_COUNT';
    readonly target?: number;
  }): Promise<{
    userId: string;
    claimId: string;
    missionVersionId: string;
    rewardRuleId: string;
    adRewardId: string | null;
  }> {
    const userId = await createTestUser(pool, String(18_200_000 + seq * 100 + (Date.now() % 1000)));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-conc-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: input?.amountAtomic ?? AMOUNT,
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-concurrency',
      }),
    );
    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16C_${randomUUID().slice(0, 8)}`, 'mission.conc'],
    );
    const conditionType = input?.conditionType ?? 'DAILY_LOGIN';
    const target = input?.target ?? 1;
    const mv = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, eligibility_policy, reward_source_type, reward_rule_id, status, start_at,
         required_membership_plan_id
       ) VALUES (
         $1::uuid, 1, $2, $3::mission_condition_type, $4, 'NONE', '{}'::jsonb,
         'MISSION', $5::uuid, 'ACTIVE', now() - interval '1 day', $6::uuid
       ) RETURNING id`,
      [
        def.rows[0]!.id,
        'mission.conc',
        conditionType,
        target,
        rule.id,
        input?.requiredMembershipPlanId ?? null,
      ],
    );
    const missionVersionId = mv.rows[0]!.id;
    let adRewardId: string | null = null;

    if (conditionType === 'DAILY_LOGIN') {
      const client = await pool.connect();
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
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      for (let i = 0; i < target; i += 1) {
        await insertAvailableAdReward(userId);
      }
      await processValidAdMissionContributionsBatch(pool, { limit: 50 });
    }

    const progress = await pool.query<{ id: string }>(
      `SELECT id FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
      [missionVersionId, userId],
    );
    const progressId = progress.rows[0]?.id;
    if (progressId === undefined) throw new Error('progress missing');

    if (conditionType === 'VALID_AD_COUNT') {
      const adRow = await pool.query<{ source_key: string }>(
        `SELECT source_key FROM mission_progress_events
         WHERE mission_progress_id = $1::uuid AND source_kind = 'REWARD_EVENT'
         LIMIT 1`,
        [progressId],
      );
      adRewardId = adRow.rows[0]?.source_key ?? null;
    }

    const prepared = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    if (prepared.claimId === null) throw new Error('claim missing');
    return {
      userId,
      claimId: prepared.claimId,
      missionVersionId,
      rewardRuleId: rule.id,
      adRewardId,
    };
  }

  async function holderPid(client: PoolClient): Promise<number> {
    return (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  }

  it('dual MAX_MISSION_BONUS_DAILY scopes: one issuance reserves both exposure periods', async () => {
    const userId = await createTestUser(pool, String(18_000_000 + seq));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-conc-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: AMOUNT,
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-concurrency',
      }),
    );
    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16C_${randomUUID().slice(0, 8)}`, 'mission.conc'],
    );
    const mv = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, eligibility_policy, reward_source_type, reward_rule_id, status, start_at
       ) VALUES (
         $1::uuid, 1, $2, 'DAILY_LOGIN', 1, 'DAILY', '{}'::jsonb,
         'MISSION', $3::uuid, 'ACTIVE', now() - interval '1 day'
       ) RETURNING id`,
      [def.rows[0]!.id, 'mission.conc', rule.id],
    );
    const missionVersionId = mv.rows[0]!.id;
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: '1000000',
      });
    });
    await seedDualExposure(missionVersionId);

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

    const issued = await issueMissionReward(pool, {
      missionClaimId: prepared.claimId!,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    const exposureRows = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM mission_bonus_exposure_reservations
       WHERE mission_claim_id = $1::uuid AND state = 'CONSUMED'`,
      [prepared.claimId],
    );
    expect(exposureRows.rows[0]?.c).toBe(2);

    const provenance = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM mission_reward_decision_exposure_periods mdep
       INNER JOIN mission_reward_decisions mrd ON mrd.id = mdep.mission_reward_decision_id
       WHERE mrd.mission_claim_id = $1::uuid AND mrd.outcome = 'ISSUED'`,
      [prepared.claimId],
    );
    expect(provenance.rows[0]?.c).toBe(2);
  });

  it('concurrent issuance on shared budget: exactly one ISSUED decision', async () => {
    const userA = await createTestUser(pool, String(18_100_000 + seq));
    const userB = await createTestUser(pool, String(18_100_001 + seq));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-race-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: AMOUNT,
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-concurrency',
      }),
    );
    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16R_${randomUUID().slice(0, 8)}`, 'mission.race'],
    );
    const mv = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, eligibility_policy, reward_source_type, reward_rule_id, status, start_at
       ) VALUES (
         $1::uuid, 1, $2, 'DAILY_LOGIN', 1, 'DAILY', '{}'::jsonb,
         'MISSION', $3::uuid, 'ACTIVE', now() - interval '1 day'
       ) RETURNING id`,
      [def.rows[0]!.id, 'mission.race', rule.id],
    );
    const missionVersionId = mv.rows[0]!.id;
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: AMOUNT,
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: '1000000',
        ruleVersion: Date.now() % 1_000_000_000 + seq,
        activate: true,
        reason: 'phase16-concurrency',
      });
    });

    async function completeAndClaim(userId: string): Promise<string> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const contributed = await contributeMissionProgress(c, {
          missionVersionId,
          userId,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: `DAY:${randomUUID()}`,
          occurredAt: new Date(),
        });
        if (contributed.outcome !== 'CONTRIBUTED') throw new Error('contribute failed');
        await c.query('COMMIT');
        const prepared = await prepareMissionClaim(pool, {
          userId,
          missionProgressId: contributed.progressId,
          deploymentEnvironment: 'LOCAL',
        });
        if (prepared.claimId === null) throw new Error('claim missing');
        return prepared.claimId;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    }

    const claimA = await completeAndClaim(userA);
    const claimB = await completeAndClaim(userB);

    const results = await Promise.all([
      issueMissionReward(pool, { missionClaimId: claimA, environment: 'LOCAL' }),
      issueMissionReward(pool, { missionClaimId: claimB, environment: 'LOCAL' }),
    ]);
    const issued = results.filter((r) => r.kind === 'issued');
    const blocked = results.filter((r) => r.kind === 'blocked_budget' || r.kind === 'blocked_exposure');
    expect(issued).toHaveLength(1);
    expect(blocked).toHaveLength(1);

    const granted = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claims WHERE status = 'GRANTED'`,
    );
    expect(granted.rows[0]?.c).toBe(1);
  });

  it('AD_REVERSAL_FIRST: reverse holds AD row; issuance blocks with no mission money', async () => {
    const setup = await createDailyLoginPendingClaim({
      conditionType: 'VALID_AD_COUNT',
      target: 1,
    });
    expect(setup.adRewardId).not.toBeNull();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM reward_events WHERE id = $1::uuid FOR UPDATE`, [
        setup.adRewardId!,
      ]);
      const hPid = await holderPid(holder);

      let issueResult: Awaited<ReturnType<typeof issueMissionRewardOnClient>> | undefined;
      const issuePromise = (async () => {
        await waiter.query('BEGIN');
        issueResult = await issueMissionRewardOnClient(waiter, {
          missionClaimId: setup.claimId,
          environment: 'LOCAL',
        });
        await waiter.query('COMMIT');
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      const grantedBefore = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM mission_claims WHERE status = 'GRANTED'`,
      );
      expect(grantedBefore.rows[0]?.c).toBe(0);

      await holder.query(
        `UPDATE reward_events SET state = 'REVERSED'::reward_event_state, reversed_at = now()
         WHERE id = $1::uuid`,
        [setup.adRewardId!],
      );
      await holder.query('COMMIT');
      await issuePromise;

      expect(issueResult?.kind).toBe('source_evidence_invalid');
      const grantedAfter = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM mission_claims WHERE status = 'GRANTED'`,
      );
      expect(grantedAfter.rows[0]?.c).toBe(0);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('MISSION_ISSUANCE_FIRST_REVERSAL_BLOCKS: issuance FOR SHARE blocks AD reverse', async () => {
    const setup = await createDailyLoginPendingClaim({
      conditionType: 'VALID_AD_COUNT',
      target: 1,
    });
    expect(setup.adRewardId).not.toBeNull();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      const issuePromise = issueMissionRewardOnClient(holder, {
        missionClaimId: setup.claimId,
        environment: 'LOCAL',
      });
      const hPid = await holderPid(holder);
      expect(await waitForHolderGrantedRelation(watcher, hPid, 'reward_events', 8_000)).toBe(true);

      let reverseDone = false;
      const reversePromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(`SELECT id FROM reward_events WHERE id = $1::uuid FOR UPDATE`, [
          setup.adRewardId!,
        ]);
        await waiter.query('ROLLBACK');
        reverseDone = true;
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      expect(reverseDone).toBe(false);

      const issueResult = await issuePromise;
      await holder.query('COMMIT');
      await reversePromise;

      expect(issueResult.kind).toBe('issued');
      expect(reverseDone).toBe(true);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it(
    'ACCOUNT_BLOCK_FIRST: account block TX blocks mission issuance FOR SHARE',
    async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`,
        [setup.userId],
      );
      const hPid = await holderPid(holder);

      let issueResult: Awaited<ReturnType<typeof issueMissionRewardOnClient>> | undefined;
      const issuePromise = (async () => {
        await waiter.query('BEGIN');
        issueResult = await issueMissionRewardOnClient(waiter, {
          missionClaimId: setup.claimId,
          environment: 'LOCAL',
        });
        await waiter.query('COMMIT');
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      await holder.query('COMMIT');
      await issuePromise;
      expect(issueResult?.kind).toBe('blocked_eligibility');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  },
  30_000,
  );

  it(
    'MISSION_ACCOUNT_LOCK_FIRST: issuance user FOR SHARE blocks account block update',
    async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM users WHERE id = $1::uuid FOR SHARE`, [setup.userId]);
      const hPid = await holderPid(holder);

      let waiterDone = false;
      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`,
          [setup.userId],
        );
        await waiter.query('COMMIT');
        waiterDone = true;
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      expect(waiterDone).toBe(false);
      await holder.query('COMMIT');
      await waitPromise;
      expect(waiterDone).toBe(true);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  },
  30_000,
  );

  it('PAUSE_FIRST: pause flip blocks issuance pause gate', async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE feature_flags SET enabled = true
         WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
      );
      const hPid = await holderPid(holder);

      let issueResult: Awaited<ReturnType<typeof issueMissionRewardOnClient>> | undefined;
      const issuePromise = (async () => {
        await waiter.query('BEGIN');
        issueResult = await issueMissionRewardOnClient(waiter, {
          missionClaimId: setup.claimId,
          environment: 'LOCAL',
        });
        await waiter.query('COMMIT');
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      await holder.query('COMMIT');
      await issuePromise;
      expect(issueResult?.kind).toBe('blocked_pause');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('MISSION_PAUSE_LOCK_FIRST: issuance pause FOR SHARE blocks pause flip', async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      const issuePromise = issueMissionRewardOnClient(holder, {
        missionClaimId: setup.claimId,
        environment: 'LOCAL',
      });
      const hPid = await holderPid(holder);
      expect(await waitForHolderGrantedRelation(watcher, hPid, 'feature_flags', 8_000)).toBe(true);

      let waiterDone = false;
      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `UPDATE feature_flags SET enabled = true
           WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
        );
        await waiter.query('COMMIT');
        waiterDone = true;
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      expect(waiterDone).toBe(false);

      const issueResult = await issuePromise;
      await holder.query('COMMIT');
      await waitPromise;
      expect(issueResult.kind).toBe('issued');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  async function seedExclusiveMembershipGate(planId: string): Promise<void> {
    const ent = await pool.query<{ id: string }>(
      `SELECT id FROM entitlements WHERE code = 'EXCLUSIVE_MISSION_ACCESS'`,
    );
    const entitlementId = ent.rows[0]!.id;
    const ruleVersion = await pool.query<{ id: string }>(
      `INSERT INTO membership_benefit_rule_versions (
         entitlement_id, membership_plan_id, rule_version, value_boolean,
         status, effective_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 1, TRUE, 'ACTIVE', now(), 'phase16-concurrency'
       ) RETURNING id`,
      [entitlementId, planId],
    );
    await pool.query(
      `INSERT INTO membership_plan_entitlements (
         membership_plan_id, entitlement_id, rule_version_id, valid_from, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
      [planId, entitlementId, ruleVersion.rows[0]!.id],
    );
  }

  async function createMembershipMonetaryClaim(planId: string): Promise<{
    userId: string;
    claimId: string;
    missionVersionId: string;
    membershipId: string;
  }> {
    await seedExclusiveMembershipGate(planId);
    const userId = await createTestUser(pool, String(18_400_000 + seq * 10 + (Date.now() % 1000)));
    const membership = await pool.query<{ id: string }>(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, status, source, claimed_at, founder_number
       ) VALUES (
         $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now(), nextval('founder_number_seq')
       ) RETURNING id`,
      [userId, planId],
    );
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-mem-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: AMOUNT,
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-concurrency',
      }),
    );
    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16M_${randomUUID().slice(0, 8)}`, 'mission.mem'],
    );
    const mv = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, eligibility_policy, reward_source_type, reward_rule_id, status, start_at,
         required_membership_plan_id
       ) VALUES (
         $1::uuid, 1, $2, 'DAILY_LOGIN'::mission_condition_type, 1, 'NONE', '{}'::jsonb,
         'MISSION', $3::uuid, 'ACTIVE', now() - interval '1 day', $4::uuid
       ) RETURNING id`,
      [def.rows[0]!.id, 'mission.mem', rule.id, planId],
    );
    const missionVersionId = mv.rows[0]!.id;
    const client = await pool.connect();
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
      await client.query('COMMIT');
      const prepared = await prepareMissionClaim(pool, {
        userId,
        missionProgressId: contributed.progressId,
        deploymentEnvironment: 'LOCAL',
      });
      if (prepared.claimId === null) throw new Error('claim missing');
      return {
        userId,
        claimId: prepared.claimId,
        missionVersionId,
        membershipId: membership.rows[0]!.id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('MEMBERSHIP_REVOKE_FIRST: revoke blocks issuance membership gate', async () => {
    const plan = await pool.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
    );
    const planId = plan.rows[0]!.id;
    const memberSetup = await createMembershipMonetaryClaim(planId);
    await seedMissionBudget(memberSetup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE user_memberships
         SET status = 'REVOKED', revoked_at = now()
         WHERE id = $1::uuid`,
        [memberSetup.membershipId],
      );
      const hPid = await holderPid(holder);

      let issueResult: Awaited<ReturnType<typeof issueMissionRewardOnClient>> | undefined;
      const issuePromise = (async () => {
        await waiter.query('BEGIN');
        issueResult = await issueMissionRewardOnClient(waiter, {
          missionClaimId: memberSetup.claimId,
          environment: 'LOCAL',
        });
        await waiter.query('COMMIT');
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      await holder.query('COMMIT');
      await issuePromise;
      expect(issueResult?.kind).toBe('blocked_eligibility');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('MISSION_MEMBERSHIP_LOCK_FIRST: issuance membership FOR SHARE blocks revoke', async () => {
    const plan = await pool.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
    );
    const planId = plan.rows[0]!.id;
    const memberSetup = await createMembershipMonetaryClaim(planId);
    await seedMissionBudget(memberSetup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      const issuePromise = issueMissionRewardOnClient(holder, {
        missionClaimId: memberSetup.claimId,
        environment: 'LOCAL',
      });
      const hPid = await holderPid(holder);
      expect(await waitForHolderGrantedRelation(watcher, hPid, 'user_memberships', 8_000)).toBe(
        true,
      );

      let waiterDone = false;
      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `UPDATE user_memberships
           SET status = 'REVOKED', revoked_at = now()
           WHERE id = $1::uuid`,
          [memberSetup.membershipId],
        );
        await waiter.query('COMMIT');
        waiterDone = true;
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      expect(waiterDone).toBe(false);

      const issueResult = await issuePromise;
      await holder.query('COMMIT');
      await waitPromise;
      expect(issueResult.kind).toBe('issued');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('RULE_LIFECYCLE_FIRST: reward rule supersession blocks pinned issuance', async () => {
    const setup = await createDailyLoginPendingClaim({ amountAtomic: '2500' });
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE reward_rules SET status = 'SUPERSEDED'::rule_version_status WHERE id = $1::uuid`,
        [setup.rewardRuleId],
      );
      const hPid = await holderPid(holder);

      let issueResult: Awaited<ReturnType<typeof issueMissionRewardOnClient>> | undefined;
      const issuePromise = (async () => {
        await waiter.query('BEGIN');
        issueResult = await issueMissionRewardOnClient(waiter, {
          missionClaimId: setup.claimId,
          environment: 'LOCAL',
        });
        await waiter.query('COMMIT');
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      await holder.query('COMMIT');
      await issuePromise;
      expect(['configuration_missing', 'blocked_eligibility']).toContain(issueResult?.kind);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('MISSION_RULE_LOCK_FIRST: issuance reward_rule FOR SHARE blocks supersession', async () => {
    const setup = await createDailyLoginPendingClaim({ amountAtomic: '2500' });
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      const issuePromise = issueMissionRewardOnClient(holder, {
        missionClaimId: setup.claimId,
        environment: 'LOCAL',
      });
      const hPid = await holderPid(holder);
      expect(await waitForHolderGrantedRelation(watcher, hPid, 'reward_rules', 8_000)).toBe(true);

      let waiterDone = false;
      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `UPDATE reward_rules SET status = 'SUPERSEDED'::rule_version_status WHERE id = $1::uuid`,
          [setup.rewardRuleId],
        );
        await waiter.query('COMMIT');
        waiterDone = true;
      })();

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      expect(waiterDone).toBe(false);

      const issueResult = await issuePromise;
      await holder.query('COMMIT');
      await waitPromise;
      expect(issueResult.kind).toBe('issued');
      expect(issueResult.amountAtomic).toBe('2500');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await waiter.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('multi-exposure: global daily limit exhausted blocks second issuance', async () => {
    await seedGlobalMissionExposure(AMOUNT);
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');

    const first = await issueMissionReward(pool, {
      missionClaimId: setup.claimId,
      environment: 'LOCAL',
    });
    expect(first.kind).toBe('issued');

    const setup2 = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup2.missionVersionId, '1000000');
    const blocked = await issueMissionReward(pool, {
      missionClaimId: setup2.claimId,
      environment: 'LOCAL',
    });
    expect(blocked.kind).toBe('blocked_exposure');
  });

  it('multi-exposure: mission-scoped limit exhausted blocks second claim on same mission', async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    const ruleVersionBase = Date.now() % 1_000_000_000 + seq;
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: '1000000',
        ruleVersion: ruleVersionBase,
        activate: true,
        reason: 'phase16-global-open',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        scopeReferenceId: setup.missionVersionId,
        limitAtomic: AMOUNT,
        ruleVersion: ruleVersionBase + 1,
        activate: true,
        reason: 'phase16-mission-cap',
      });
    });

    const issued = await issueMissionReward(pool, {
      missionClaimId: setup.claimId,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    const userB = await createTestUser(pool, String(18_300_000 + seq));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId: setup.missionVersionId,
        userId: userB,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:${randomUUID()}`,
        occurredAt: new Date(),
      });
      if (contributed.outcome !== 'CONTRIBUTED') throw new Error('contribute failed');
      await client.query('COMMIT');
      const progressId = contributed.progressId;
      const prepared = await prepareMissionClaim(pool, {
        userId: userB,
        missionProgressId: progressId,
        deploymentEnvironment: 'LOCAL',
      });
      if (prepared.claimId === null) throw new Error('claim missing');
      const blocked = await issueMissionReward(pool, {
        missionClaimId: prepared.claimId,
        environment: 'LOCAL',
      });
      expect(blocked.kind).toBe('blocked_exposure');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('multi-exposure: single claim blocked when global capacity insufficient despite mission room', async () => {
    const setup = await createDailyLoginPendingClaim({ amountAtomic: '1000' });
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: setup.missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: '1000000',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: '500',
        ruleVersion: Date.now() % 1_000_000_000 + seq,
        activate: true,
        reason: 'global-tight',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        scopeReferenceId: setup.missionVersionId,
        limitAtomic: '5000',
        ruleVersion: Date.now() % 1_000_000_000 + seq + 1,
        activate: true,
        reason: 'mission-loose',
      });
    });
    const result = await issueMissionReward(pool, {
      missionClaimId: setup.claimId,
      environment: 'LOCAL',
    });
    expect(result.kind).toBe('blocked_exposure');
  });

  it('multi-exposure: single claim blocked when mission capacity insufficient despite global room', async () => {
    const setup = await createDailyLoginPendingClaim({ amountAtomic: '1000' });
    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: setup.missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: '1000000',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: '5000',
        ruleVersion: Date.now() % 1_000_000_000 + seq,
        activate: true,
        reason: 'global-loose',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        scopeReferenceId: setup.missionVersionId,
        limitAtomic: '500',
        ruleVersion: Date.now() % 1_000_000_000 + seq + 1,
        activate: true,
        reason: 'mission-tight',
      });
    });
    const result = await issueMissionReward(pool, {
      missionClaimId: setup.claimId,
      environment: 'LOCAL',
    });
    expect(result.kind).toBe('blocked_exposure');
  });

  it('provenance 0055: UPDATE/DELETE on mission_reward_decision_exposure_periods rejected', async () => {
    const setup = await createDailyLoginPendingClaim();
    await seedMissionBudget(setup.missionVersionId, '1000000');
    await seedGlobalMissionExposure('1000000');
    const issued = await issueMissionReward(pool, {
      missionClaimId: setup.claimId,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    const row = await pool.query<{ id: string }>(
      `SELECT mdep.id
       FROM mission_reward_decision_exposure_periods mdep
       INNER JOIN mission_reward_decisions mrd ON mrd.id = mdep.mission_reward_decision_id
       WHERE mrd.mission_claim_id = $1::uuid
       LIMIT 1`,
      [setup.claimId],
    );
    const provenanceId = row.rows[0]?.id;
    expect(provenanceId).toBeTruthy();

    await expect(
      pool.query(
        `UPDATE mission_reward_decision_exposure_periods SET amount_atomic = 1 WHERE id = $1::uuid`,
        [provenanceId],
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      pool.query(`DELETE FROM mission_reward_decision_exposure_periods WHERE id = $1::uuid`, [
        provenanceId,
      ]),
    ).rejects.toThrow(/append-only/i);
  });
});
