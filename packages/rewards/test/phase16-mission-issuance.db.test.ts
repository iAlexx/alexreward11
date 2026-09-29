/**
 * Phase 16 Step 5 — budgeted mission reward issuance.
 * Destructive against PHASE16_DATABASE_URL (preferred) or PHASE15_DATABASE_URL.
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
  matureRewardEvent,
  processDueMissionRewardMaturityBatch,
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

const AMOUNT = '2500';

async function seedEligibilityPolicy(pool: Pool, version: number): Promise<void> {
  await pool.query(
    `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`,
  );
  await pool.query(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, reason, policy_config
     ) VALUES (
       $1, 'ACTIVE', now() - interval '1 day', 'phase16-step5-test', $2::jsonb
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

describe.skipIf(phase16Url === '')('Phase 16 Step 5 mission reward issuance (DB)', () => {
  let pool: Pool;
  let assetId: string;
  let seq = 0;
  let policyVersion = 1650;

  beforeAll(async () => {
    await resetAndMigrate(phase16Url);
    pool = new Pool({ connectionString: phase16Url, max: 12 });
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
        user_memberships,
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
    const ruleVersion = Date.now() % 1_000_000_000;
    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: limitAtomic.toString(10),
        ruleVersion,
        activate: true,
        reason: 'phase16-step5-test',
      });
    });
  }

  async function createCompletedMonetaryClaim(input?: {
    readonly amountAtomic?: string;
    readonly pendingHoldSeconds?: number;
  }): Promise<{
    userId: string;
    claimId: string;
    missionVersionId: string;
    progressId: string;
    rewardRuleId: string;
  }> {
    const userId = await createTestUser(pool, String(16_500_000 + seq * 100 + Date.now() % 1000));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-rule-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: input?.amountAtomic ?? AMOUNT,
        pendingHoldSeconds: input?.pendingHoldSeconds ?? 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'phase16-step5-test',
      }),
    );

    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P16S5_${randomUUID().slice(0, 8)}`, 'mission.test'],
    );
    const defId = def.rows[0]!.id;
    const ver = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, condition_type, target,
         reset_policy, status, start_at, end_at, reward_source_type, reward_rule_id
       ) VALUES (
         $1::uuid, 1, 'mission.test', 'DAILY_LOGIN'::mission_condition_type, 1,
         'NONE'::mission_reset_policy, 'ACTIVE', now() - interval '1 day', NULL,
         'MISSION'::reward_source_type, $2::uuid
       ) RETURNING id`,
      [defId, rule.id],
    );
    const missionVersionId = ver.rows[0]!.id;

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
    expect(prepared.claimId).toBeTruthy();

    return {
      userId,
      claimId: prepared.claimId!,
      missionVersionId,
      progressId,
      rewardRuleId: rule.id,
    };
  }

  it('issues PENDING MISSION reward with correct ledger and matures to AVAILABLE', async () => {
    const created = await createCompletedMonetaryClaim({ pendingHoldSeconds: 0 });
    await seedMissionBudget(created.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(1_000_000n);

    const result = await issueMissionReward(pool, {
      missionClaimId: created.claimId,
      environment: 'LOCAL',
    });
    expect(result.kind).toBe('issued');
    expect(result.amountAtomic).toBe(AMOUNT);
    expect(result.rewardEventId).not.toBeNull();
    expect(result.ledgerTransactionId).not.toBeNull();

    const event = await pool.query<{
      source_type: string;
      state: string;
      amount_atomic: string;
      reward_rule_id: string;
    }>(
      `SELECT source_type::text AS source_type, state::text AS state,
              amount_atomic::text AS amount_atomic, reward_rule_id
       FROM reward_events WHERE id = $1`,
      [result.rewardEventId],
    );
    expect(event.rows[0]).toMatchObject({
      source_type: 'MISSION',
      state: 'PENDING',
      amount_atomic: AMOUNT,
      reward_rule_id: created.rewardRuleId,
    });

    const ledger = await pool.query<{ transaction_type: string }>(
      `SELECT transaction_type::text AS transaction_type
       FROM ledger_transactions WHERE id = $1`,
      [result.ledgerTransactionId],
    );
    expect(ledger.rows[0]?.transaction_type).toBe('MISSION_REWARD_ISSUANCE');

    const entries = await pool.query<{ account_type: string; direction: string }>(
      `SELECT la.account_type::text AS account_type, le.direction::text AS direction
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.id = le.ledger_account_id
       WHERE le.ledger_transaction_id = $1
       ORDER BY le.direction`,
      [result.ledgerTransactionId],
    );
    expect(entries.rows).toEqual(
      expect.arrayContaining([
        { account_type: 'MISSION_REWARD_EXPENSE', direction: 'DEBIT' },
        { account_type: 'USER_PENDING_LIABILITY', direction: 'CREDIT' },
      ]),
    );

    const claim = await pool.query<{ status: string; reward_event_id: string }>(
      `SELECT status::text AS status, reward_event_id FROM mission_claims WHERE id = $1`,
      [created.claimId],
    );
    expect(claim.rows[0]?.status).toBe('GRANTED');
    expect(claim.rows[0]?.reward_event_id).toBe(result.rewardEventId);

    const matured = await matureRewardEvent(pool, {
      rewardEventId: result.rewardEventId!,
      asOf: new Date(),
    });
    expect(matured.state).toBe('AVAILABLE');
    const after = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [result.rewardEventId],
    );
    expect(after.rows[0]?.state).toBe('AVAILABLE');

    const retry = await issueMissionReward(pool, {
      missionClaimId: created.claimId,
      environment: 'LOCAL',
    });
    expect(retry.kind).toBe('already_granted');
    expect(retry.rewardEventId).toBe(result.rewardEventId);
    expect(retry.ledgerTransactionId).toBe(result.ledgerTransactionId);

    const taskLedger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions
       WHERE transaction_type = 'TASK_REWARD_ISSUANCE'`,
    );
    expect(taskLedger.rows[0]?.c).toBe(0);
  });

  it('blocks pause / missing budget / exhausted exposure without granting', async () => {
    const paused = await createCompletedMonetaryClaim();
    await seedMissionBudget(paused.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(1_000_000n);
    await pool.query(
      `UPDATE feature_flags SET enabled = true
       WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
    );
    const pauseResult = await issueMissionReward(pool, {
      missionClaimId: paused.claimId,
      environment: 'LOCAL',
    });
    expect(pauseResult.kind).toBe('blocked_pause');
    expect(
      (
        await pool.query<{ status: string }>(
          `SELECT status::text AS status FROM mission_claims WHERE id = $1`,
          [paused.claimId],
        )
      ).rows[0]?.status,
    ).toBe('PENDING');
    await pool.query(
      `UPDATE feature_flags SET enabled = false
       WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = 'LOCAL'`,
    );

    await pool.query(
      `TRUNCATE TABLE economic_exposure_periods, economic_exposure_limits, reward_budget_periods RESTART IDENTITY CASCADE`,
    );

    const noBudget = await createCompletedMonetaryClaim();
    await seedDailyMissionExposure(1_000_000n);
    const missingBudget = await issueMissionReward(pool, {
      missionClaimId: noBudget.claimId,
      environment: 'LOCAL',
    });
    expect(missingBudget.kind).toBe('blocked_budget');
    expect(missingBudget.reasonCode).toBe('MISSION_BUDGET_MISSING');

    await pool.query(
      `TRUNCATE TABLE economic_exposure_periods, economic_exposure_limits, reward_budget_periods RESTART IDENTITY CASCADE`,
    );

    const noExposure = await createCompletedMonetaryClaim();
    await seedMissionBudget(noExposure.missionVersionId, 1_000_000n);
    const missingExposure = await issueMissionReward(pool, {
      missionClaimId: noExposure.claimId,
      environment: 'LOCAL',
    });
    expect(missingExposure.kind).toBe('blocked_exposure');
    expect(missingExposure.reasonCode).toBe('MAX_MISSION_BONUS_DAILY_MISSING');

    await pool.query(
      `TRUNCATE TABLE economic_exposure_periods, economic_exposure_limits, reward_budget_periods RESTART IDENTITY CASCADE`,
    );

    const tiny = await createCompletedMonetaryClaim({ amountAtomic: '100' });
    await seedMissionBudget(tiny.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(50n);
    const exhausted = await issueMissionReward(pool, {
      missionClaimId: tiny.claimId,
      environment: 'LOCAL',
    });
    expect(exhausted.kind).toBe('blocked_exposure');
    expect(exhausted.reasonCode).toBe('MAX_MISSION_BONUS_DAILY_EXHAUSTED');
  });

  it('maturity batch processes due MISSION rewards', async () => {
    const created = await createCompletedMonetaryClaim({ pendingHoldSeconds: 0 });
    await seedMissionBudget(created.missionVersionId, 1_000_000n);
    await seedDailyMissionExposure(1_000_000n);
    const issued = await issueMissionReward(pool, {
      missionClaimId: created.claimId,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    const batch = await processDueMissionRewardMaturityBatch(pool, { limit: 10 });
    expect(batch.scanned).toBeGreaterThanOrEqual(1);
    const ok = batch.items.find((i) => i.ok && i.rewardEventId === issued.rewardEventId);
    expect(ok?.ok).toBe(true);
  });
});
