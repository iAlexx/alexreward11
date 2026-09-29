/**
 * Phase 16 MEGA remediation — deterministic issuance concurrency (DB).
 */
import { randomUUID } from 'node:crypto';

import {
  contributeMissionProgress,
  prepareMissionClaim,
} from '@alex-rewards/tasks';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createExposureLimitVersion,
  createRewardBudgetPeriod,
  createRewardRuleVersion,
  issueMissionReward,
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
});
