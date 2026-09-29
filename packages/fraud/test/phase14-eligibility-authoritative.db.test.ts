import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  collectConfiguredRiskSignals,
  evaluateAndPersistEligibility,
  evaluateAndPersistRisk,
  resolveActiveRiskRuleVersion,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  insertRiskRule,
  phase14DatabaseUrl,
  resetAndMigrate,
  TEST_ELIGIBILITY_POLICY_CONFIG,
  TEST_RULE_THRESHOLDS,
} from './harness.js';

const SERVER_NOW = new Date('2026-07-01T00:00:00.000Z');
const RESTRICT_VIOLATION = '23001';

const STEP11_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

function useServerTime(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

async function assetId(pool: Pool): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM assets ORDER BY created_at ASC LIMIT 1`,
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('seed asset missing');
  return id;
}

async function insertReversedAdReward(
  pool: Pool,
  input: { userId: string; sourceId: string; at: Date; reversedAt?: Date | null },
): Promise<void> {
  const asset = await assetId(pool);
  await pool.query(
    `INSERT INTO reward_events (
       user_id, source_type, source_id, asset_id, amount_atomic, state,
       created_at, reversed_at
     ) VALUES (
       $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, 100, 'REVERSED'::reward_event_state,
       $4::timestamptz, $5::timestamptz
     )`,
    [
      input.userId,
      input.sourceId,
      asset,
      input.at.toISOString(),
      input.reversedAt === undefined
        ? input.at.toISOString()
        : input.reversedAt === null
          ? null
          : input.reversedAt.toISOString(),
    ],
  );
}

async function insertReferralEdge(
  pool: Pool,
  input: {
    referrerUserId: string;
    referredUserId: string;
    state: 'PENDING' | 'ACTIVE' | 'REJECTED';
    createdAt: Date;
    rejectedAt?: Date | null;
    code: string;
  },
): Promise<void> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code)
     VALUES ($1::uuid, $2)
     ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [input.referrerUserId, input.code],
  );
  const codeId = code.rows[0]?.id;
  if (codeId === undefined) throw new Error('referral code insert failed');
  await pool.query(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state, created_at, rejected_at,
       rejection_reason, attributed_at, activated_at, activation_rule_version
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::referral_edge_state,
       $5::timestamptz, $6::timestamptz,
       $7, $5::timestamptz, $8::timestamptz, $9
     )`,
    [
      input.referrerUserId,
      input.referredUserId,
      codeId,
      input.state,
      input.createdAt.toISOString(),
      input.rejectedAt === undefined
        ? input.state === 'REJECTED'
          ? input.createdAt.toISOString()
          : null
        : input.rejectedAt === null
          ? null
          : input.rejectedAt.toISOString(),
      input.state === 'REJECTED' ? 'phase14-test-rejected' : null,
      input.state === 'ACTIVE' ? input.createdAt.toISOString() : null,
      // ACTIVE edges require activation_rule_version; fixture uses a synthetic version
      // only when a matching referral_rule_versions row exists (Phase 15+). PENDING/REJECTED stay NULL.
      null,
    ],
  );
}

async function grantFounder(pool: Pool, userId: string): Promise<void> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  await pool.query(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at, founder_number
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now(),
       nextval('founder_number_seq')
     )`,
    [userId, planId],
  );
}

async function setWithdrawalPause(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE feature_flags
     SET enabled = $1
     WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE' AND environment = 'LOCAL'`,
    [enabled],
  );
}

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Step 11 history signals (DB)', () => {
  let pool: Pool;
  let userId: string;
  let otherUserId: string;
  let referredUserId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000110');
    otherUserId = await createTestUser(pool, '14000111');
    referredUserId = await createTestUser(pool, '14000112');
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // History collectors use Postgres now() — do not fake Date for these tests.
    await pool.query(`DELETE FROM risk_profiles WHERE user_id = ANY($1::uuid[])`, [
      [userId, otherUserId, referredUserId],
    ]);
    await pool.query(`DELETE FROM reward_events WHERE user_id = ANY($1::uuid[])`, [
      [userId, otherUserId, referredUserId],
    ]);
    await pool.query(
      `DELETE FROM referral_edges
       WHERE referrer_user_id = ANY($1::uuid[]) OR referred_user_id = ANY($1::uuid[])`,
      [[userId, otherUserId, referredUserId]],
    );
    await pool.query(`DELETE FROM referral_codes WHERE user_id = ANY($1::uuid[])`, [
      [userId, otherUserId, referredUserId],
    ]);
    await pool.query(
      `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
    );
  });

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  it('AD_REVERSED_REWARD_HISTORY activates at minCount inside window; ignores outside window', async () => {
    await insertRiskRule(pool, {
      ruleVersion: 1101,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { AD_REVERSED_REWARD_HISTORY: 40 },
      signalParams: {
        AD_REVERSED_REWARD_HISTORY: { minCount: 2, windowDays: 10 },
      },
      actions: STEP11_ACTIONS,
    });

    await insertReversedAdReward(pool, {
      userId,
      sourceId: '00000000-0000-4000-8000-000000001101',
      at: daysAgo(3),
    });

    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client);
      const below = await collectConfiguredRiskSignals(client, { userId, rule });
      expect(below.signalFacts).toHaveLength(1);
      expect(below.signalFacts[0]).toMatchObject({
        code: 'AD_REVERSED_REWARD_HISTORY',
        active: false,
        reasonCode: 'NO_AD_REVERSED_REWARD_HISTORY',
        safeDetails: { reversedAdRewardCount: 1 },
      });
    } finally {
      client.release();
    }

    await insertReversedAdReward(pool, {
      userId,
      sourceId: '00000000-0000-4000-8000-000000001102',
      at: daysAgo(1),
    });
    await insertReversedAdReward(pool, {
      userId,
      sourceId: '00000000-0000-4000-8000-000000001103',
      at: daysAgo(40),
    });

    const client2 = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client2);
      const atMin = await collectConfiguredRiskSignals(client2, { userId, rule });
      expect(atMin.signalFacts[0]).toMatchObject({
        code: 'AD_REVERSED_REWARD_HISTORY',
        active: true,
        reasonCode: 'AD_REVERSED_REWARD_HISTORY',
        safeDetails: { reversedAdRewardCount: 2 },
      });
    } finally {
      client2.release();
    }
  });

  it('REFERRAL_REJECTED_EDGE_HISTORY is referrer-only (not referred)', async () => {
    await insertRiskRule(pool, {
      ruleVersion: 1102,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { REFERRAL_REJECTED_EDGE_HISTORY: 30 },
      signalParams: {
        REFERRAL_REJECTED_EDGE_HISTORY: { minCount: 1, windowDays: 30 },
      },
      actions: STEP11_ACTIONS,
    });

    await insertReferralEdge(pool, {
      referrerUserId: userId,
      referredUserId,
      state: 'REJECTED',
      createdAt: daysAgo(2),
      code: 'REF1102A',
    });
    await insertReferralEdge(pool, {
      referrerUserId: otherUserId,
      referredUserId: userId,
      state: 'REJECTED',
      createdAt: daysAgo(2),
      code: 'REF1102B',
    });

    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client);
      const asReferrer = await collectConfiguredRiskSignals(client, { userId, rule });
      expect(asReferrer.signalFacts[0]).toMatchObject({
        code: 'REFERRAL_REJECTED_EDGE_HISTORY',
        active: true,
        safeDetails: { rejectedReferralCount: 1 },
      });

      // userId is also a referred party on another edge — must not inflate referrer count.
      const asReferredOnly = await collectConfiguredRiskSignals(client, {
        userId: referredUserId,
        rule,
      });
      expect(asReferredOnly.signalFacts[0]).toMatchObject({
        code: 'REFERRAL_REJECTED_EDGE_HISTORY',
        active: false,
        safeDetails: { rejectedReferralCount: 0 },
      });
    } finally {
      client.release();
    }
  });

  it('referenced signal_params are immutable once risk_snapshots exist', async () => {
    await insertRiskRule(pool, {
      ruleVersion: 1103,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: {
        AD_REVERSED_REWARD_HISTORY: 15,
      },
      signalParams: {
        AD_REVERSED_REWARD_HISTORY: { minCount: 1, windowDays: 7 },
      },
      actions: STEP11_ACTIONS,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await expect(
      pool.query(
        `UPDATE risk_rule_versions
         SET signal_params = $1::jsonb
         WHERE rule_version = 1103`,
        [JSON.stringify({ AD_REVERSED_REWARD_HISTORY: { minCount: 9, windowDays: 99 } })],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Step 11 evaluateAndPersistEligibility (DB)',
  () => {
    let pool: Pool;
    let userId: string;
    let founderUserId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14000120');
      founderUserId = await createTestUser(pool, '14000121');
      await grantFounder(pool, founderUserId);

      await insertRiskRule(pool, {
        ruleVersion: 1201,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        thresholds: TEST_RULE_THRESHOLDS,
        signalWeights: { OPEN_HIGH_FRAUD_FLAG: 80 },
        signalParams: {},
        actions: {
          LOW: 'ALLOW',
          MEDIUM: 'EXTEND_PENDING',
          HIGH: 'WITHDRAWAL_BLOCKED',
          CRITICAL: 'WITHDRAWAL_BLOCKED',
        },
      });
      await insertEligibilityPolicy(pool, {
        policyVersion: 1201,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      useServerTime(SERVER_NOW);
      await setWithdrawalPause(pool, false);
      await pool.query(
        `UPDATE users
         SET status = 'ACTIVE'::user_status,
             withdrawal_status = 'ALLOWED'::user_withdrawal_access_status,
             withdrawal_cooldown_until = NULL
         WHERE id = ANY($1::uuid[])`,
        [[userId, founderUserId]],
      );
      await pool.query(`DELETE FROM fraud_flags WHERE user_id = ANY($1::uuid[])`, [
        [userId, founderUserId],
      ]);
      await pool.query(`DELETE FROM risk_profiles WHERE user_id = ANY($1::uuid[])`, [
        [userId, founderUserId],
      ]);
    });

    afterEach(async () => {
      vi.useRealTimers();
      await setWithdrawalPause(pool, false);
    });

    it('eligible path persists decision without caller-supplied gates', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(result.evaluation.outcome).toBe('ELIGIBLE');
        expect(result.decision.outcome).toBe('ELIGIBLE');
        expect(result.decision.safeInputs).toMatchObject({
          policyVersion: result.policy.policyVersion,
          actionType: 'WITHDRAWAL_REQUEST',
          deploymentEnvironment: 'LOCAL',
          primaryBlockedGateCode: null,
        });
        expect(result.risk).toBeDefined();
        expect(result.risk?.evaluation.action).toBe('ALLOW');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });

    it('account NON_ACTIVE / BLOCKED / COOLDOWN / RESTRICTED map correctly', async () => {
      await pool.query(
        `UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`,
        [userId],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const suspended = await evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(suspended.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
        expect(
          suspended.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.safeDetails,
        ).toMatchObject({ stateClass: 'NON_ACTIVE' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      await pool.query(
        `UPDATE users
         SET status = 'ACTIVE'::user_status,
             withdrawal_status = 'BLOCKED'::user_withdrawal_access_status
         WHERE id = $1::uuid`,
        [userId],
      );
      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        const blocked = await evaluateAndPersistEligibility(client2, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(blocked.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
        expect(
          blocked.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.safeDetails,
        ).toMatchObject({ stateClass: 'BLOCKED' });
        await client2.query('ROLLBACK');
      } finally {
        client2.release();
      }

      await pool.query(
        `UPDATE users
         SET withdrawal_status = 'ALLOWED'::user_withdrawal_access_status,
             withdrawal_cooldown_until = $2::timestamptz
         WHERE id = $1::uuid`,
        [userId, new Date('2026-08-01T00:00:00.000Z').toISOString()],
      );
      const client3 = await pool.connect();
      try {
        await client3.query('BEGIN');
        const cooldown = await evaluateAndPersistEligibility(client3, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(cooldown.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
        expect(
          cooldown.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.safeDetails,
        ).toMatchObject({ stateClass: 'COOLDOWN' });
        await client3.query('ROLLBACK');
      } finally {
        client3.release();
      }

      await pool.query(
        `UPDATE users
         SET withdrawal_cooldown_until = NULL,
             withdrawal_status = 'RESTRICTED'::user_withdrawal_access_status
         WHERE id = $1::uuid`,
        [userId],
      );
      const client4 = await pool.connect();
      try {
        await client4.query('BEGIN');
        const restricted = await evaluateAndPersistEligibility(client4, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(restricted.evaluation.outcome).toBe('ELIGIBLE');
        expect(
          restricted.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE'),
        ).toMatchObject({
          eligible: true,
          safeDetails: expect.objectContaining({ stateClass: 'RESTRICTED' }),
        });
        await client4.query('ROLLBACK');
      } finally {
        client4.release();
      }
    });

    it('WITHDRAWAL_REQUESTS_PAUSE enabled blocks via FEATURE_FLAG', async () => {
      await setWithdrawalPause(pool, true);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const paused = await evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(paused.evaluation.outcome).toBe('INELIGIBLE_FEATURE_DISABLED');
        expect(paused.evaluation.primaryBlockedGateCode).toBe('FEATURE_FLAG');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('risk allow/deny follows riskAllowedActions; Founder cannot bypass RISK', async () => {
      await pool.query(
        `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details)
         VALUES ($1::uuid, 'STEP11_HIGH', 'HIGH'::severity_level, 'OPEN'::fraud_flag_status, '{}'::jsonb)`,
        [userId],
      );
      await pool.query(
        `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details)
         VALUES ($1::uuid, 'STEP11_HIGH', 'HIGH'::severity_level, 'OPEN'::fraud_flag_status, '{}'::jsonb)`,
        [founderUserId],
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const denied = await evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(denied.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');
        expect(denied.risk?.evaluation.action).toBe('WITHDRAWAL_BLOCKED');

        const founderDenied = await evaluateAndPersistEligibility(client, {
          userId: founderUserId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(founderDenied.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');
        expect(founderDenied.risk?.evaluation.action).toBe('WITHDRAWAL_BLOCKED');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('COUNTRY_POLICY required fails closed with ELIGIBILITY_GATE_SOURCE_UNAVAILABLE', async () => {
      await pool.query(
        `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertEligibilityPolicy(pool, {
        policyVersion: 1299,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: {
          actions: {
            WITHDRAWAL_REQUEST: {
              requiredGates: ['ACCOUNT_STATE', 'COUNTRY_POLICY'],
              precedence: ['COUNTRY_POLICY', 'ACCOUNT_STATE'],
            },
          },
        },
      });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          evaluateAndPersistEligibility(client, {
            userId,
            actionType: 'WITHDRAWAL_REQUEST',
            serverContext: { deploymentEnvironment: 'LOCAL' },
          }),
        ).rejects.toMatchObject({ code: 'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      await pool.query(
        `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertEligibilityPolicy(pool, {
        policyVersion: 1300,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
    });

    it('writes no ledger entries', async () => {
      const before = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ledger_entries`,
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const after = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM ledger_entries`,
      );
      expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
    });

    it('missing WITHDRAWAL_REQUESTS_PAUSE row fails closed', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          evaluateAndPersistEligibility(client, {
            userId,
            actionType: 'WITHDRAWAL_REQUEST',
            serverContext: { deploymentEnvironment: 'PRODUCTION' },
          }),
        ).rejects.toBeInstanceOf(FraudDomainError);
        await expect(
          evaluateAndPersistEligibility(client, {
            userId,
            actionType: 'WITHDRAWAL_REQUEST',
            serverContext: { deploymentEnvironment: 'PRODUCTION' },
          }),
        ).rejects.toMatchObject({ code: 'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  },
);
