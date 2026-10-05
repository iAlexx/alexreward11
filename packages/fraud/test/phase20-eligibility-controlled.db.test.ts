/**
 * Phase 20 Step 2 — controlled disposable-DB fraud/eligibility proofs.
 * TEST / DISPOSABLE DB ONLY — never auto-seed staging/production.
 *
 * Gate: PHASE20_DATABASE_URL or PHASE20_STEP2_REQUIRE_DB_GATES=1 (required)
 * or PHASE20_FRAUD_TESTS=1 + DATABASE_URL.
 *
 * Fixture numbers are REFERENCE ONLY — NOT APPROVED FOR STAGING.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import {
  FraudDomainError,
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
  TEST_ELIGIBILITY_POLICY_CONFIG,
  TEST_TRUST_POLICY_CONFIG,
} from './harness.js';

function resolvePhase20DatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP2_REQUIRE_DB_GATES === '1') {
    throw new Error(
      'PHASE20_STEP2_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL (disposable *_test DB)',
    );
  }
  if (process.env.PHASE20_FRAUD_TESTS === '1') {
    return process.env.DATABASE_URL ?? '';
  }
  return '';
}

const dbUrl = resolvePhase20DatabaseUrl();

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

describe.skipIf(dbUrl === '')('Phase 20 fraud/eligibility controlled fixtures (DB)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    // TEST/DISPOSABLE ONLY — destructive reset of alex_rewards_phase20_test (or gated URL).
    await resetAndMigrate(dbUrl);
    pool = createPool(dbUrl);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  describe('fail-closed before ACTIVE fixtures', () => {
    it('missing ACTIVE risk policy fail-closes', async () => {
      const userId = await createTestUser(pool, String(Date.now()));
      await expect(
        withTx(pool, (client) =>
          evaluateAndPersistRisk(client, {
            userId,
            decisionScope: 'WITHDRAWAL_REQUEST',
          }),
        ),
      ).rejects.toBeInstanceOf(FraudDomainError);
    });

    it('missing ACTIVE eligibility policy fail-closes', async () => {
      const userId = await createTestUser(pool, String(Date.now() + 1));
      await expect(
        withTx(pool, (client) =>
          evaluateAndPersistEligibility(client, {
            userId,
            actionType: 'WITHDRAWAL_REQUEST',
            serverContext: { deploymentEnvironment: 'LOCAL' },
          }),
        ),
      ).rejects.toBeInstanceOf(FraudDomainError);
    });
  });

  describe('ACTIVE TEST fixtures (REFERENCE ONLY — NOT APPROVED FOR STAGING)', () => {
    beforeAll(async () => {
      // Insert ACTIVE after missing-policy proofs so fail-closed cases stay valid.
      await insertRiskRule(pool, {
        ruleVersion: 1,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        signalWeights: { OPEN_HIGH_FRAUD_FLAG: 80 },
      });
      await insertTrustRule(pool, {
        ruleVersion: 1,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        policyConfig: TEST_TRUST_POLICY_CONFIG,
      });
      await insertEligibilityPolicy(pool, {
        policyVersion: 1,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
    });

    it('ACTIVE TEST fixtures allow evaluateAndPersist Risk/Trust/Eligibility', async () => {
      const userId = await createTestUser(pool, String(Date.now() + 2));

      const risk = await withTx(pool, (client) =>
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
        }),
      );
      expect(risk.snapshot.id).toBeTruthy();

      const trust = await withTx(pool, (client) =>
        evaluateAndPersistTrust(client, { userId }),
      );
      expect(trust.snapshot.id).toBeTruthy();

      const eligibility = await withTx(pool, (client) =>
        evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        }),
      );
      expect(eligibility.decision.id).toBeTruthy();
      expect(eligibility.evaluation.outcome).toBe('ELIGIBLE');
    });

    it('blocked withdrawal access fail-closes WITHDRAWAL_REQUEST', async () => {
      const userId = await createTestUser(pool, String(Date.now() + 4));
      await pool.query(
        `UPDATE users
         SET withdrawal_status = 'BLOCKED'::user_withdrawal_access_status
         WHERE id = $1::uuid`,
        [userId],
      );

      const result = await withTx(pool, (client) =>
        evaluateAndPersistEligibility(client, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          serverContext: { deploymentEnvironment: 'LOCAL' },
        }),
      );
      expect(result.evaluation.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
      expect(result.decision.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
    });
  });

  it('evaluate-and-persist-eligibility.ts forbids client authority fields', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/evaluate-and-persist-eligibility.ts'),
      'utf8',
    );
    expect(src).toMatch(/EvaluateAndPersistEligibilityInput/);
    expect(src).not.toMatch(/readonly\s+outcome\s*:/);
    expect(src).not.toMatch(/readonly\s+gateFacts\s*:/);
    expect(src).not.toMatch(/readonly\s+clientScore\s*:/);
  });
});