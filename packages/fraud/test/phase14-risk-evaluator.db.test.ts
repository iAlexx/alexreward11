import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  evaluateAndPersistRisk,
  type RiskRuleVersion,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertRiskRule,
  phase14DatabaseUrl,
  resetAndMigrate,
  TEST_RULE_THRESHOLDS,
  TEST_RULE_WEIGHTS,
} from './harness.js';

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 evaluateAndPersistRisk DB', () => {
  let pool: Pool;
  let userId: string;
  let rule: RiskRuleVersion;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000014');
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { ...TEST_RULE_WEIGHTS, PRIOR_FLAGS: 30, HEAVY_A: 60, HEAVY_B: 50 },
      actions: {
        LOW: 'ALLOW',
        MEDIUM: 'EXTEND_PENDING',
        HIGH: 'MANUAL_REVIEW',
        CRITICAL: 'WITHDRAWAL_BLOCKED',
      },
    });
    const loaded = await pool.query<{
      id: string;
      rule_version: number;
      thresholds: unknown;
      signal_weights: unknown;
      actions: unknown;
      status: string;
      effective_from: Date;
      effective_to: Date | null;
      reason: string | null;
      audit_reference: string | null;
    }>(
      `SELECT id, rule_version, thresholds, signal_weights, actions, status::text AS status,
              effective_from, effective_to, reason, audit_reference
       FROM risk_rule_versions WHERE rule_version = 1`,
    );
    const row = loaded.rows[0]!;
    rule = {
      id: row.id,
      ruleVersion: row.rule_version,
      thresholds: row.thresholds as RiskRuleVersion['thresholds'],
      signalWeights: row.signal_weights as RiskRuleVersion['signalWeights'],
      actions: row.actions as RiskRuleVersion['actions'],
      status: 'ACTIVE',
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      reason: row.reason,
      auditReference: row.audit_reference,
    };
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('persists snapshot + profile; second evaluation updates profile and preserves old snapshot', async () => {
    // One evaluateAndPersistRisk call => exactly one snapshot + one profile upsert.
    // Reevaluation may create a later audit snapshot; there is no global snapshot dedupe.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        rule,
        signalFacts: [
          { code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' },
          { code: 'WALLET_REUSE', active: false, reasonCode: 'WALLET_OK' },
        ],
        safeContext: { evaluationLabel: 'first' },
      });
      expect(first.evaluation.score).toBe(10);
      expect(first.snapshot.score).toBe(10);
      expect(first.snapshot.ruleVersion).toBe(1);
      expect(first.profile.score).toBe(10);
      expect(first.profile.ruleVersion).toBe(1);
      const firstSnapshotId = first.snapshot.id;

      // In-memory rule version 2 (no DB ACTIVE overlap); rule_version is integer, not FK.
      const ruleV2: RiskRuleVersion = {
        ...rule,
        ruleVersion: 2,
      };

      const second = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        rule: ruleV2,
        signalFacts: [
          { code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' },
          { code: 'WALLET_REUSE', active: true, reasonCode: 'WALLET_REUSE_ACTIVE' },
        ],
        safeContext: { evaluationLabel: 'second' },
      });
      expect(second.evaluation.score).toBe(25); // ACCOUNT_AGE 10 + WALLET_REUSE 15 (TEST_RULE_WEIGHTS)
      expect(second.profile.score).toBe(25);
      expect(second.profile.ruleVersion).toBe(2);
      expect(second.snapshot.id).not.toBe(firstSnapshotId);

      const oldSnap = await client.query<{ score: number; rule_version: number }>(
        `SELECT score, rule_version FROM risk_snapshots WHERE id = $1::uuid`,
        [firstSnapshotId],
      );
      expect(oldSnap.rows[0]?.score).toBe(10);
      expect(oldSnap.rows[0]?.rule_version).toBe(1);

      const profiles = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
        [userId],
      );
      expect(profiles.rows[0]?.cnt).toBe('1');

      const user = await client.query<{ status: string; withdrawal_status: string }>(
        `SELECT status::text AS status, withdrawal_status::text AS withdrawal_status
         FROM users WHERE id = $1::uuid`,
        [userId],
      );
      expect(user.rows[0]?.status).toBe('ACTIVE');
      expect(user.rows[0]?.withdrawal_status).toBe('ALLOWED');

      const ledger = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM ledger_entries`,
      );
      expect(ledger.rows[0]?.cnt).toBe('0');

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('failed evaluation creates no snapshot/profile mutation', async () => {
    const beforeProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );
    const beforeSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          rule,
          signalFacts: [{ code: 'NOT_IN_RULE', active: true, reasonCode: 'UNKNOWN_SIGNAL' }],
        }),
      ).rejects.toBeInstanceOf(FraudDomainError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const afterProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );
    const afterSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(afterProfiles.rows[0]?.cnt).toBe(beforeProfiles.rows[0]?.cnt);
    expect(afterSnaps.rows[0]?.cnt).toBe(beforeSnaps.rows[0]?.cnt);
  });

  it('rejects sensitive safeContext / details', async () => {
    const client = await pool.connect();
    try {
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          rule,
          signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
          safeContext: { access_token: 'nope' },
        }),
      ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });
    } finally {
      client.release();
    }
  });
});
