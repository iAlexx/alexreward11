/**
 * Phase 20 Step 4A.1 — action-aware ACCOUNT_STATE + FEATURE_FLAG binding proofs.
 * Disposable DB only. Does not activate staging policies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { FraudDomainError, evaluateAndPersistEligibility } from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  insertRiskRule,
  resetAndMigrate,
  TEST_ELIGIBILITY_POLICY_CONFIG,
  TEST_RULE_THRESHOLDS,
} from './harness.js';

function resolvePhase20DatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP4A1_REQUIRE_DB_GATES === '1') {
    throw new Error('PHASE20_STEP4A1_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  }
  if (process.env.PHASE14_DATABASE_URL) return process.env.PHASE14_DATABASE_URL;
  return process.env.PHASE14_FRAUD_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
}

const dbUrl = resolvePhase20DatabaseUrl();

async function setFlag(pool: Pool, flagKey: string, enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO feature_flags (flag_key, environment, enabled, description)
     VALUES ($1, 'LOCAL', $2, 'phase20-4a1-test')
     ON CONFLICT (flag_key, environment) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [flagKey, enabled],
  );
}

describe.skipIf(dbUrl === '')('Phase 20 eligibility gate semantics (DB)', () => {
  let pool!: Pool;
  let userId!: string;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = createPool(dbUrl);
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      signalWeights: { OPEN_HIGH_FRAUD_FLAG: 10 },
      thresholds: TEST_RULE_THRESHOLDS,
      actions: {
        LOW: 'ALLOW',
        MEDIUM: 'MANUAL_REVIEW',
        HIGH: 'HELD',
        CRITICAL: 'WITHDRAWAL_BLOCKED',
      },
    });
    await insertEligibilityPolicy(pool, {
      policyVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
    });
    await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', false);
    userId = await createTestUser(pool, String(Date.now()));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it('inactive user refuses AD_SESSION_START and WITHDRAWAL_REQUEST', async () => {
    const uid = await createTestUser(pool, String(Date.now() + 1));
    await pool.query(`UPDATE users SET status = 'SUSPENDED'::user_status WHERE id = $1::uuid`, [
      uid,
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const actionType of ['AD_SESSION_START', 'WITHDRAWAL_REQUEST'] as const) {
        const r = await evaluateAndPersistEligibility(client, {
          userId: uid,
          actionType,
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(r.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('withdrawal cooldown blocks WITHDRAWAL_REQUEST but not AD_SESSION_START ACCOUNT_STATE', async () => {
    const uid = await createTestUser(pool, String(Date.now() + 2));
    await pool.query(
      `UPDATE users
       SET withdrawal_cooldown_until = (now() + interval '1 day')
       WHERE id = $1::uuid`,
      [uid],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wd = await evaluateAndPersistEligibility(client, {
        userId: uid,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      });
      expect(wd.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
      expect(
        wd.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.safeDetails,
      ).toMatchObject({ stateClass: 'COOLDOWN', withdrawalScopedChecksApplied: true });

      const ad = await evaluateAndPersistEligibility(client, {
        userId: uid,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      });
      expect(ad.evaluation.outcome).toBe('ELIGIBLE');
      expect(
        ad.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.safeDetails,
      ).toMatchObject({
        stateClass: 'ACTIVE_ALLOWED',
        withdrawalScopedChecksApplied: false,
        cooldownActive: true,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('withdrawal_status BLOCKED blocks WITHDRAWAL_REQUEST; AD_SESSION_START ACCOUNT_STATE still OK', async () => {
    const uid = await createTestUser(pool, String(Date.now() + 3));
    await pool.query(
      `UPDATE users
       SET withdrawal_status = 'BLOCKED'::user_withdrawal_access_status
       WHERE id = $1::uuid`,
      [uid],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wd = await evaluateAndPersistEligibility(client, {
        userId: uid,
        actionType: 'WITHDRAWAL_REQUEST',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      });
      expect(wd.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');

      const ad = await evaluateAndPersistEligibility(client, {
        userId: uid,
        actionType: 'AD_SESSION_START',
        serverContext: { deploymentEnvironment: 'LOCAL' },
      });
      expect(ad.evaluation.outcome).toBe('ELIGIBLE');
      expect(
        ad.evaluation.gateState.find((g) => g.code === 'ACCOUNT_STATE')?.reasonCode,
      ).toBe('ACCOUNT_STATE_OK');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it(
    'WITHDRAWAL_REQUESTS_PAUSE does not affect AD_SESSION_START; unsupported FEATURE_FLAG fails closed',
    async () => {
      await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', true);
      const uid = await createTestUser(pool, String(Date.now() + 4));

      const client1 = await pool.connect();
      try {
        await client1.query('BEGIN');
        const ad = await evaluateAndPersistEligibility(client1, {
          userId: uid,
          actionType: 'AD_SESSION_START',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        });
        expect(ad.evaluation.outcome).toBe('ELIGIBLE');
        await client1.query('ROLLBACK');
      } finally {
        client1.release();
      }

      await pool.query(
        `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertEligibilityPolicy(pool, {
        policyVersion: 99,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: {
          actions: {
            AD_SESSION_START: {
              requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
              precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            },
            TASK_CLAIM: {
              requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
              precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
            },
          },
        },
      });

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await expect(
          evaluateAndPersistEligibility(client2, {
            userId: uid,
            actionType: 'AD_SESSION_START',
            serverContext: { deploymentEnvironment: 'LOCAL' },
          }),
        ).rejects.toMatchObject({
          code: 'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
        });
        await expect(
          evaluateAndPersistEligibility(client2, {
            userId: uid,
            actionType: 'TASK_CLAIM',
            serverContext: { deploymentEnvironment: 'LOCAL' },
          }),
        ).rejects.toBeInstanceOf(FraudDomainError);
        await client2.query('ROLLBACK');
      } finally {
        client2.release();
      }

      await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', false);
      await pool.query(
        `UPDATE eligibility_policy_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertEligibilityPolicy(pool, {
        policyVersion: 100,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
    },
    30_000,
  );

  it('WITHDRAWAL_REQUEST still reads only WITHDRAWAL_REQUESTS_PAUSE', async () => {
    await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', true);
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
      expect(
        paused.evaluation.gateState.find((g) => g.code === 'FEATURE_FLAG')?.safeDetails,
      ).toMatchObject({ flagKey: 'WITHDRAWAL_REQUESTS_PAUSE' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await setFlag(pool, 'WITHDRAWAL_REQUESTS_PAUSE', false);
    }
  });
});