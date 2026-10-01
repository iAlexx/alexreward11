/**
 * P19-SEC-014 — PENDING claim must not issue after mission version REVOKED.
 */
import { randomUUID } from 'node:crypto';

import { contributeMissionProgress, prepareMissionClaim } from '@alex-rewards/tasks';
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
    : phase5DatabaseUrl;

const AMOUNT = '2500';

async function seedEligibilityPolicy(pool: Pool, version: number): Promise<void> {
  await pool.query(`UPDATE eligibility_policy_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`);
  await pool.query(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, reason, policy_config
     ) VALUES (
       $1, 'ACTIVE', now() - interval '1 day', 'p19-revoke-issuance', $2::jsonb
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

describe.skipIf(phase16Url === '')('P19-SEC-014 pending claim after revoke (DB)', () => {
  let pool: Pool;
  let assetId: string;
  let seq = 0;
  let policyVersion = 19150;

  beforeAll(async () => {
    await resetAndMigrate(phase16Url);
    pool = new Pool({ connectionString: phase16Url, max: 8 });
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

  it('PENDING claim + later REVOKED => no reward / no ledger', async () => {
    const userId = await createTestUser(pool, String(19_140_000 + seq));
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `mission-rule-${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: AMOUNT,
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        activate: true,
        referralEligible: false,
        reason: 'p19-revoke-issuance',
      }),
    );

    const def = await pool.query<{ id: string }>(
      `INSERT INTO mission_definitions (code, name_key, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [`P19ISS_${randomUUID().slice(0, 8)}`, 'mission.p19'],
    );
    const ver = await pool.query<{ id: string }>(
      `INSERT INTO mission_versions (
         mission_definition_id, mission_version, name_key, description_key,
         condition_type, target, reset_policy, eligibility_policy,
         reward_source_type, reward_rule_id, status, start_at, end_at
       ) VALUES (
         $1::uuid, 1, 'n', 'd', 'DAILY_LOGIN', 1, 'NONE', '{}'::jsonb,
         'MISSION'::reward_source_type, $2::uuid,
         'ACTIVE'::rule_version_status, now() - interval '1 day', NULL
       ) RETURNING id`,
      [def.rows[0]!.id, rule.id],
    );
    const missionVersionId = ver.rows[0]!.id;

    const day = utcDayContaining(new Date());
    await withLedgerTransaction(pool, async (client) => {
      await createRewardBudgetPeriod(client, {
        scopeType: 'MISSION',
        scopeReferenceId: missionVersionId,
        assetId,
        granularity: 'UTC_DAY',
        periodStart: day.periodStart,
        periodEnd: day.periodEnd,
        budgetAtomic: '100000',
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_MISSION_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: '100000',
        ruleVersion: Date.now() % 1_000_000_000,
        activate: true,
        reason: 'p19-revoke-issuance',
      });
    });

    const client = await pool.connect();
    let progressId: string;
    try {
      await client.query('BEGIN');
      const contributed = await contributeMissionProgress(client, {
        missionVersionId,
        userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: `DAY:p19-iss-${randomUUID()}`,
        occurredAt: new Date(),
      });
      progressId = contributed.progressId;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const prepared = await prepareMissionClaim(pool, {
      userId,
      missionProgressId: progressId,
      deploymentEnvironment: 'LOCAL',
    });
    expect(prepared.outcome).toBe('CLAIM_PENDING');

    await pool.query(
      `UPDATE mission_versions SET status = 'REVOKED'::rule_version_status WHERE id = $1::uuid`,
      [missionVersionId],
    );

    const issued = await issueMissionReward(pool, {
      missionClaimId: prepared.claimId!,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('configuration_missing');
    expect(issued.reasonCode).toBe('MISSION_VERSION_REVOKED');
    expect(issued.rewardEventId).toBeNull();
    expect(issued.ledgerTransactionId).toBeNull();
  });
});
