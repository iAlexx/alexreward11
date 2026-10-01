/**
 * Phase 20 Step 4B — disposable DB validation of Owner-approved Closed Beta policy.
 * TEST/DISPOSABLE ACTIVE rows only. Never staging/ops.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY as APPROVED,
  evaluateAndPersistEligibility,
  evaluateAndPersistRisk,
  evaluateAndPersistTrust,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  insertRiskRule,
  insertTrustRule,
  resetAndMigrate,
} from './harness.js';

function resolveDbUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP4B_REQUIRE_DB_GATES === '1') {
    throw new Error('PHASE20_STEP4B_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  }
  return process.env.PHASE14_DATABASE_URL ?? '';
}

const dbUrl = resolveDbUrl();

async function setFlag(pool: Pool, flagKey: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO feature_flags (flag_key, environment, enabled, description)
     VALUES ($1, 'LOCAL', $2, 'phase20-step4b')
     ON CONFLICT (flag_key, environment) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [flagKey, enabled],
  );
}

async function insertOpenFlag(
  pool: Pool,
  userId: string,
  severity: 'HIGH' | 'CRITICAL',
): Promise<void> {
  await pool.query(
    `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details)
     VALUES ($1::uuid, $2, $3::severity_level, 'OPEN'::fraud_flag_status, '{}'::jsonb)`,
    [userId, `P20_4B_${severity}`, severity],
  );
}

async function insertConfirmedFlag(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details, reviewed_at)
     VALUES ($1::uuid, 'P20_4B_CONFIRMED', 'HIGH'::severity_level, 'CONFIRMED'::fraud_flag_status, '{}'::jsonb, now())`,
    [userId],
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

async function withTx<T>(pool: Pool, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

describe.skipIf(dbUrl === '')('Phase 20 Step 4B Owner-approved policy (DB disposable)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = createPool(dbUrl);
    await insertRiskRule(pool, {
      ruleVersion: 20,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      thresholds: APPROVED.risk.thresholds,
      signalWeights: APPROVED.risk.signalWeights,
      signalParams: APPROVED.risk.signalParams,
      actions: APPROVED.risk.actions,
    });
    await insertTrustRule(pool, {
      ruleVersion: 20,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      policyConfig: APPROVED.trust,
    });
    await insertEligibilityPolicy(pool, {
      policyVersion: 20,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      policyConfig: APPROVED.eligibility,
    });
    await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', false);
    await setFlag(pool, 'MISSION_REWARD_PAUSE', false);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it('risk: no signal → LOW / MANUAL_REVIEW', async () => {
    const userId = await createTestUser(pool, String(Date.now()));
    const r = await withTx(pool, (c) =>
      evaluateAndPersistRisk(c, { userId, decisionScope: 'AD_SESSION_START' }),
    );
    expect(r.evaluation).toMatchObject({
      score: 0,
      riskTier: 'LOW',
      action: 'MANUAL_REVIEW',
      neverAutoBan: true,
    });
  });

  it('risk: OPEN_HIGH alone → HIGH / HELD', async () => {
    const userId = await createTestUser(pool, String(Date.now() + 1));
    await insertOpenFlag(pool, userId, 'HIGH');
    const r = await withTx(pool, (c) =>
      evaluateAndPersistRisk(c, { userId, decisionScope: 'AD_SESSION_START' }),
    );
    expect(r.evaluation).toMatchObject({ score: 55, riskTier: 'HIGH', action: 'HELD' });
  });

  it('risk: OPEN_CRITICAL alone → CRITICAL / WITHDRAWAL_BLOCKED', async () => {
    const userId = await createTestUser(pool, String(Date.now() + 2));
    await insertOpenFlag(pool, userId, 'CRITICAL');
    const r = await withTx(pool, (c) =>
      evaluateAndPersistRisk(c, { userId, decisionScope: 'WITHDRAWAL_REQUEST' }),
    );
    expect(r.evaluation).toMatchObject({
      score: 80,
      riskTier: 'CRITICAL',
      action: 'WITHDRAWAL_BLOCKED',
    });
  });

  it('risk: CONFIRMED alone → HIGH / HELD; SHARED_PAYOUT alone → MEDIUM', async () => {
    const confirmedUser = await createTestUser(pool, String(Date.now() + 3));
    await insertConfirmedFlag(pool, confirmedUser);
    const confirmed = await withTx(pool, (c) =>
      evaluateAndPersistRisk(c, { userId: confirmedUser, decisionScope: 'AD_SESSION_START' }),
    );
    expect(confirmed.evaluation).toMatchObject({
      score: 60,
      riskTier: 'HIGH',
      action: 'HELD',
    });

    // SHARED_PAYOUT needs shared verified primary wallet — create two users same wallet address.
    const a = await createTestUser(pool, String(Date.now() + 4));
    const b = await createTestUser(pool, String(Date.now() + 5));
    const network = await pool.query<{ id: string }>(
      `SELECT id FROM networks ORDER BY created_at ASC LIMIT 1`,
    );
    const networkId = network.rows[0]?.id;
    if (networkId === undefined) throw new Error('network missing');
    const addr = `EQ_P20_4B_${Date.now()}`;
    for (const uid of [a, b]) {
      await pool.query(
        `INSERT INTO user_wallets (
           user_id, network_id, chain, raw_address, friendly_address,
           is_primary, verified, verification_method, verified_at, became_primary_at
         ) VALUES (
           $1::uuid, $2::uuid, 'TON', $3, $3,
           true, true, 'TON_PROOF', now(), now()
         )`,
        [uid, networkId, addr],
      );
    }
    const shared = await withTx(pool, (c) =>
      evaluateAndPersistRisk(c, { userId: a, decisionScope: 'AD_SESSION_START' }),
    );
    expect(shared.evaluation).toMatchObject({
      score: 35,
      riskTier: 'MEDIUM',
      action: 'MANUAL_REVIEW',
    });
  });

  it('AD_SESSION_START: ordinary eligible; HIGH/CRITICAL blocked; cooldown/BLOCKED do not block AD', async () => {
    const ordinary = await createTestUser(pool, String(Date.now() + 10));
    const ok = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: ordinary,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(ok.evaluation.outcome).toBe('ELIGIBLE');

    const highUser = await createTestUser(pool, String(Date.now() + 11));
    await insertOpenFlag(pool, highUser, 'HIGH');
    const high = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: highUser,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(high.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');

    const critUser = await createTestUser(pool, String(Date.now() + 12));
    await insertOpenFlag(pool, critUser, 'CRITICAL');
    const crit = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: critUser,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(crit.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');

    const coolUser = await createTestUser(pool, String(Date.now() + 13));
    await pool.query(
      `UPDATE users SET withdrawal_cooldown_until = now() + interval '1 day' WHERE id = $1::uuid`,
      [coolUser],
    );
    const coolAd = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: coolUser,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(coolAd.evaluation.outcome).toBe('ELIGIBLE');

    const blockedUser = await createTestUser(pool, String(Date.now() + 14));
    await pool.query(
      `UPDATE users SET withdrawal_status = 'BLOCKED'::user_withdrawal_access_status WHERE id = $1::uuid`,
      [blockedUser],
    );
    const blockedAd = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: blockedUser,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(blockedAd.evaluation.outcome).toBe('ELIGIBLE');

    const inactive = await createTestUser(pool, String(Date.now() + 15));
    await pool.query(`UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`, [
      inactive,
    ]);
    const inactiveAd = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: inactive,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(inactiveAd.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
  });

  it('WITHDRAWAL_REQUEST: pause/cooldown/BLOCKED/HIGH/CRITICAL block; LOW does not auto-approve payout', async () => {
    const userId = await createTestUser(pool, String(Date.now() + 20));

    await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', true);
    const paused = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(paused.evaluation.outcome).toBe('INELIGIBLE_FEATURE_DISABLED');
    await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', false);

    await pool.query(
      `UPDATE users SET withdrawal_cooldown_until = now() + interval '1 day' WHERE id = $1::uuid`,
      [userId],
    );
    const cool = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(cool.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
    await pool.query(`UPDATE users SET withdrawal_cooldown_until = NULL WHERE id = $1::uuid`, [
      userId,
    ]);

    await pool.query(
      `UPDATE users SET withdrawal_status = 'BLOCKED'::user_withdrawal_access_status WHERE id = $1::uuid`,
      [userId],
    );
    const blocked = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(blocked.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
    await pool.query(
      `UPDATE users SET withdrawal_status = 'ALLOWED'::user_withdrawal_access_status WHERE id = $1::uuid`,
      [userId],
    );

    const highUser = await createTestUser(pool, String(Date.now() + 21));
    await insertOpenFlag(pool, highUser, 'HIGH');
    const high = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: highUser,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(high.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');

    const critUser = await createTestUser(pool, String(Date.now() + 22));
    await insertOpenFlag(pool, critUser, 'CRITICAL');
    const crit = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: critUser,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(crit.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');

    const lowUser = await createTestUser(pool, String(Date.now() + 23));
    const low = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: lowUser,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(low.evaluation.outcome).toBe('ELIGIBLE');
    expect(low.risk?.evaluation.action).toBe('MANUAL_REVIEW');
    // Eligibility ELIGIBLE must never mean payout auto-approved.
    const wd = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawals WHERE user_id = $1::uuid`,
      [lowUser],
    );
    expect(wd.rows[0]?.c).toBe(0);
  });

  it('trust: NEW / age BASIC / age+wallet ESTABLISHED', async () => {
    const brandNew = await createTestUser(pool, String(Date.now() + 30));
    const neu = await withTx(pool, (c) => evaluateAndPersistTrust(c, { userId: brandNew }));
    expect(neu.evaluation).toMatchObject({ score: 0, trustState: 'NEW' });

    const aged = await createTestUser(pool, String(Date.now() + 31));
    await pool.query(
      `UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1::uuid`,
      [aged],
    );
    const basic = await withTx(pool, (c) => evaluateAndPersistTrust(c, { userId: aged }));
    expect(basic.evaluation).toMatchObject({ score: 25, trustState: 'BASIC' });

    const network = await pool.query<{ id: string }>(
      `SELECT id FROM networks ORDER BY created_at ASC LIMIT 1`,
    );
    const networkId = network.rows[0]?.id;
    if (networkId === undefined) throw new Error('network missing');
    await pool.query(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, $3,
         true, true, 'TON_PROOF',
         now() - interval '2 days', now() - interval '2 days'
       )`,
      [aged, networkId, `EQ_P20_TRUST_${Date.now()}`],
    );
    const established = await withTx(pool, (c) => evaluateAndPersistTrust(c, { userId: aged }));
    expect(established.evaluation).toMatchObject({ score: 50, trustState: 'ESTABLISHED' });
  });

  it('Founder cannot bypass risk eligibility blocks', async () => {
    const founder = await createTestUser(pool, String(Date.now() + 40));
    await grantFounder(pool, founder);
    await insertOpenFlag(pool, founder, 'HIGH');
    const denied = await withTx(pool, (c) =>
      evaluateAndPersistEligibility(c, {
        userId: founder,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      }),
    );
    expect(denied.evaluation.outcome).toBe('INELIGIBLE_RISK_POLICY');
    expect(denied.risk?.evaluation.action).toBe('HELD');
  });
});