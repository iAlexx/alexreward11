/**
 * Phase 14 Step 14 — Admin fraud read model + ensure (DB).
 * Destructive against PHASE14_DATABASE_URL (or PHASE14_FRAUD_TESTS=1 + DATABASE_URL).
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  assertFutureDomainMutationAvailable,
  ensureReviewCase,
} from '@alex-rewards/control-center';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FraudAdminController } from '../src/admin/fraud-admin.controller.js';

const explicitUrl = process.env.PHASE14_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE14_FRAUD_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const phase14DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const DIGEST_A = createHash('sha256').update('phase14-fraud-admin-a').digest('hex');
const DIGEST_B = createHash('sha256').update('phase14-fraud-admin-b').digest('hex');

async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 fraud-admin DB', () => {
  let pool: Pool;
  let controller: FraudAdminController;
  let userId: string;
  let adminUserId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = new Pool({ connectionString: phase14DatabaseUrl });
    controller = new FraudAdminController(pool, {
      adminAllowedOrigins: ['http://localhost:3001'],
    } as never);

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, preferred_locale)
       VALUES ($1::bigint, 'en')
       RETURNING id`,
      ['914000000001'],
    );
    userId = user.rows[0]!.id;

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Phase14 Fraud Admin', 'ACTIVE')
       RETURNING id`,
      [`phase14-fraud-admin-${randomUUID()}@example.invalid`],
    );
    adminUserId = admin.rows[0]!.id;
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [adminUserId, role.rows[0]!.id],
    );

    await pool.query(
      `INSERT INTO risk_rule_versions (
         rule_version, thresholds, signal_weights, signal_params, actions, status,
         effective_from, reason
       ) VALUES (
         1414,
         '{"lowMax":20,"mediumMax":50,"highMax":75}'::jsonb,
         '{"SHARED_PAYOUT_WALLET":15}'::jsonb,
         '{}'::jsonb,
         '{"LOW":"MANUAL_REVIEW","MEDIUM":"MANUAL_REVIEW","HIGH":"HELD","CRITICAL":"WITHDRAWAL_BLOCKED"}'::jsonb,
         'ACTIVE'::rule_version_status,
         now() - interval '1 hour',
         'phase14-fraud-admin-test-only'
       )`,
    );

    await pool.query(
      `INSERT INTO risk_profiles (
         user_id, score, risk_tier, rule_version, reason_codes, calculated_at
       ) VALUES (
         $1::uuid, 42, 'MEDIUM'::risk_tier, 1414,
         ARRAY['SHARED_PAYOUT_WALLET']::text[], now()
       )`,
      [userId],
    );

    await pool.query(
      `INSERT INTO risk_snapshots (
         user_id, decision_scope, score, risk_tier, rule_version,
         reason_codes, inputs_digest, safe_inputs, outputs
       ) VALUES (
         $1::uuid, 'WITHDRAWAL_REQUEST'::eligibility_action_type, 42, 'MEDIUM'::risk_tier, 1414,
         ARRAY['SHARED_PAYOUT_WALLET','AD_REVERSED_REWARD_HISTORY']::text[],
         $2,
         $3::jsonb,
         '{"score":42,"riskTier":"MEDIUM","configuredAction":"MANUAL_REVIEW","neverAutoBan":true}'::jsonb
       )`,
      [
        userId,
        DIGEST_A,
        JSON.stringify({
          ruleVersion: 1414,
          signalEvidence: [
            {
              code: 'SHARED_PAYOUT_WALLET',
              active: true,
              reasonCode: 'SHARED_PAYOUT_WALLET',
              safeDetails: { relatedAccountCount: 2 },
            },
            {
              code: 'AD_REVERSED_REWARD_HISTORY',
              active: true,
              reasonCode: 'AD_REVERSED_REWARD_HISTORY',
              safeDetails: { reversedAdRewardCount: 3 },
            },
          ],
        }),
      ],
    );

    await pool.query(
      `INSERT INTO trust_rule_versions (
         rule_version, status, effective_from, reason, policy_config
       ) VALUES (
         1414,
         'ACTIVE'::rule_version_status,
         now() - interval '1 hour',
         'phase14-fraud-admin-trust-test-only',
         $1::jsonb
       )`,
      [
        JSON.stringify({
          signals: {
            ACCOUNT_AGE: { weight: 25, minDays: 7 },
            VERIFIED_PRIMARY_WALLET_AGE: { weight: 25, minDays: 3 },
            REWARDED_AD_HISTORY: { weight: 25, minCount: 1 },
            CONFIRMED_PAYOUT_HISTORY: { weight: 25, minCount: 1 },
          },
          stateThresholds: {
            basicMin: 25,
            establishedMin: 50,
            trustedMin: 75,
          },
        }),
      ],
    );

    await pool.query(`UPDATE users SET trust_state = 'ESTABLISHED'::trust_state WHERE id = $1::uuid`, [
      userId,
    ]);

    await pool.query(
      `INSERT INTO trust_snapshots (
         user_id, trust_state, trust_score, rule_version, reason_codes, signals
       ) VALUES (
         $1::uuid, 'ESTABLISHED'::trust_state, 55, 1414,
         ARRAY['ACCOUNT_AGE']::text[], '{"ruleVersion":1414}'::jsonb
       )`,
      [userId],
    );

    await pool.query(
      `INSERT INTO eligibility_policy_versions (
         policy_version, status, effective_from, reason, policy_config
       ) VALUES (
         1414,
         'ACTIVE'::rule_version_status,
         now() - interval '1 hour',
         'phase14-fraud-admin-eligibility-test-only',
         $1::jsonb
       )`,
      [
        JSON.stringify({
          actions: {
            WITHDRAWAL_REQUEST: {
              requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY', 'FEATURE_FLAG'],
              precedence: ['RISK_POLICY', 'ACCOUNT_STATE', 'FEATURE_FLAG'],
              riskAllowedActions: ['ALLOW', 'EXTEND_PENDING', 'MANUAL_REVIEW', 'HELD'],
            },
            AD_SESSION_START: {
              requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
              precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            },
            MISSION_CLAIM: {
              requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
              precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            },
            TASK_CLAIM: {
              requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
              precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            },
          },
        }),
      ],
    );

    await pool.query(
      `INSERT INTO eligibility_decisions (
         user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
       ) VALUES (
         $1::uuid, 'WITHDRAWAL_REQUEST'::eligibility_action_type,
         'INELIGIBLE_RISK_POLICY'::eligibility_outcome,
         ARRAY['RISK_POLICY_BLOCKED']::text[], 1414,
         $2,
         '{"actionType":"WITHDRAWAL_REQUEST"}'::jsonb
       )`,
      [userId, DIGEST_B],
    );

    await pool.query(
      `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details)
       VALUES ($1::uuid, 'ADMIN_TEST_FLAG', 'HIGH'::severity_level, 'OPEN'::fraud_flag_status, '{}'::jsonb)`,
      [userId],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('GET fraud?userId returns READY evidence envelope with safe aggregates', async () => {
    const body = await controller.read(userId);
    expect(body.contractVersion).toBe('1');
    expect(body.phase14Engine.status).toBe('READY');
    expect(body.status).toBe('READY');
    expect(body.data?.userId).toBe(userId);
    expect(body.data?.riskProfile).toMatchObject({
      score: 42,
      riskTier: 'MEDIUM',
      ruleVersion: 1414,
    });
    expect(body.data?.latestRiskSnapshot?.safeAggregates).toEqual({
      relatedPayoutAccountCount: 2,
      reversedAdRewardCount: 3,
      signalCodesPresent: ['SHARED_PAYOUT_WALLET', 'AD_REVERSED_REWARD_HISTORY'],
    });
    expect(JSON.stringify(body.data?.latestRiskSnapshot)).not.toMatch(
      /"ip"|walletAddress|initData|private_key/i,
    );
    expect(body.data?.trustCurrent?.trustState).toBe('ESTABLISHED');
    expect(body.data?.latestTrustSnapshot?.ruleVersion).toBe(1414);
    expect(body.data?.recentEligibilityDecisions[0]).toMatchObject({
      outcome: 'INELIGIBLE_RISK_POLICY',
      policyVersion: 1414,
    });
    expect(body.data?.openOrConfirmedFraudFlags).toHaveLength(1);
    expect(body.data?.openOrConfirmedFraudFlags[0]?.flagType).toBe('ADMIN_TEST_FLAG');
  });

  it('GET fraud/:userId matches query form', async () => {
    const byParam = await controller.readByUser(userId);
    const byQuery = await controller.read(userId);
    expect(byParam.data?.riskProfile).toEqual(byQuery.data?.riskProfile);
    expect(byParam.phase14Engine.status).toBe('READY');
  });

  it('ensure FRAUD_REVIEW via control-center surfaces on read; no mark-safe', async () => {
    const first = await ensureReviewCase(pool, {
      caseType: 'FRAUD_REVIEW',
      resourceType: 'user',
      resourceId: userId,
      priority: 'HIGH',
      summary: 'phase14-fraud-admin ensure',
      reasonCodes: ['ADMIN_FRAUD_REVIEW_ENSURE'],
      adminUserId,
    });
    const second = await ensureReviewCase(pool, {
      caseType: 'FRAUD_REVIEW',
      resourceType: 'user',
      resourceId: userId,
      priority: 'HIGH',
      summary: 'should reuse',
      adminUserId,
    });
    expect(second.id).toBe(first.id);

    const body = await controller.read(userId);
    expect(body.data?.liveFraudReviewCases.some((c) => c.id === first.id)).toBe(true);
    expect(body.data?.liveFraudReviewCases[0]?.caseType).toBe('FRAUD_REVIEW');
    expect(body.data?.liveFraudReviewCases[0]?.state).toBe('OPEN');

    expect(() => assertFutureDomainMutationAvailable('fraud.mark_safe')).toThrow();
  });

  it('adverse evidence reconstructable: risk snapshot + eligibility share user linkage', async () => {
    const linked = await pool.query<{
      snapshot_id: string;
      decision_id: string;
      outcome: string;
      risk_tier: string;
    }>(
      `SELECT s.id AS snapshot_id, d.id AS decision_id,
              d.outcome::text AS outcome, s.risk_tier::text AS risk_tier
       FROM risk_snapshots s
       JOIN eligibility_decisions d ON d.user_id = s.user_id
       WHERE s.user_id = $1::uuid
       ORDER BY s.calculated_at DESC, d.decided_at DESC
       LIMIT 1`,
      [userId],
    );
    expect(linked.rows[0]?.snapshot_id).toBeTruthy();
    expect(linked.rows[0]?.decision_id).toBeTruthy();
    expect(linked.rows[0]?.outcome).toBe('INELIGIBLE_RISK_POLICY');

    const fk = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'withdrawals_risk_snapshot_fkey'
       ) AS exists`,
    );
    expect(fk.rows[0]?.exists).toBe(true);
  });

  it('list without userId returns live FRAUD_REVIEW queue', async () => {
    const body = await controller.read();
    expect(body.phase14Engine.status).toBe('READY');
    expect(body.data?.userId).toBeNull();
    expect(body.data?.liveFraudReviewCases.length).toBeGreaterThanOrEqual(1);
  });
});
