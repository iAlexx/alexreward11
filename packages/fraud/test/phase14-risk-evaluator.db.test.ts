import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  evaluateAndPersistRisk,
  resolveActiveRiskRuleVersion,
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

const BOUNDARY = new Date('2026-06-01T00:00:00.000Z');
const BEFORE_BOUNDARY = new Date('2026-03-01T00:00:00.000Z');
const AFTER_BOUNDARY = new Date('2026-07-01T00:00:00.000Z');

const TEST_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

const SIGNAL_WEIGHTS = {
  ...TEST_RULE_WEIGHTS,
  PRIOR_FLAGS: 30,
  HEAVY_A: 60,
  HEAVY_B: 50,
} as const;

function useServerTime(at: Date): void {
  // Fake Date only so async pg I/O is not stalled by timer mocks.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 evaluateAndPersistRisk DB', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000014');

    // Real non-overlapping ACTIVE windows (migration 0034).
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: BOUNDARY,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: SIGNAL_WEIGHTS,
      actions: TEST_ACTIONS,
    });
    await insertRiskRule(pool, {
      ruleVersion: 2,
      status: 'ACTIVE',
      effectiveFrom: BOUNDARY,
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: SIGNAL_WEIGHTS,
      actions: TEST_ACTIONS,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    useServerTime(AFTER_BOUNDARY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves DB rule versions by server time; preserves old snapshot; updates profile', async () => {
    // One evaluateAndPersistRisk call => exactly one snapshot + one profile upsert.
    // Reevaluation may create a later audit snapshot; there is no global snapshot dedupe.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      useServerTime(BEFORE_BOUNDARY);
      const first = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        signalFacts: [
          { code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' },
          { code: 'WALLET_REUSE', active: false, reasonCode: 'WALLET_OK' },
        ],
        safeContext: { evaluationLabel: 'first' },
      });

      expect(first.rule.ruleVersion).toBe(1);
      expect(first.evaluation.score).toBe(10);
      expect(first.evaluation.riskTier).toBe('LOW');
      expect(first.evaluation.ruleVersion).toBe(1);
      expect(first.evaluation.reasonCodes).toEqual(['ACCOUNT_AGE_ACTIVE']);
      expect(first.snapshot.score).toBe(first.evaluation.score);
      expect(first.snapshot.riskTier).toBe(first.evaluation.riskTier);
      expect(first.snapshot.ruleVersion).toBe(first.evaluation.ruleVersion);
      expect(first.snapshot.reasonCodes).toEqual(first.evaluation.reasonCodes);
      expect(first.profile.score).toBe(first.evaluation.score);
      expect(first.profile.riskTier).toBe(first.evaluation.riskTier);
      expect(first.profile.ruleVersion).toBe(first.evaluation.ruleVersion);
      expect(first.profile.reasonCodes).toEqual(first.evaluation.reasonCodes);
      expect(first.snapshot.safeInputs).toMatchObject({
        ruleVersion: 1,
        context: { evaluationLabel: 'first' },
      });
      const firstSnapshotId = first.snapshot.id;

      useServerTime(AFTER_BOUNDARY);
      const second = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        signalFacts: [
          { code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' },
          { code: 'WALLET_REUSE', active: true, reasonCode: 'WALLET_REUSE_ACTIVE' },
        ],
        safeContext: { evaluationLabel: 'second' },
      });

      expect(second.rule.ruleVersion).toBe(2);
      expect(second.evaluation.score).toBe(25);
      expect(second.evaluation.ruleVersion).toBe(2);
      expect(second.snapshot.ruleVersion).toBe(2);
      expect(second.profile.ruleVersion).toBe(2);
      expect(second.profile.score).toBe(25);
      expect(second.snapshot.id).not.toBe(firstSnapshotId);
      expect(second.evaluation.reasonCodes).toEqual(second.snapshot.reasonCodes);
      expect(second.snapshot.reasonCodes).toEqual(second.profile.reasonCodes);

      const oldSnap = await client.query<{ score: number; rule_version: number }>(
        `SELECT score, rule_version FROM risk_snapshots WHERE id = $1::uuid`,
        [firstSnapshotId],
      );
      expect(oldSnap.rows[0]?.score).toBe(10);
      expect(oldSnap.rows[0]?.rule_version).toBe(1);

      const profiles = await client.query<{ cnt: string; rule_version: number }>(
        `SELECT count(*)::text AS cnt, max(rule_version) AS rule_version
         FROM risk_profiles WHERE user_id = $1::uuid`,
        [userId],
      );
      expect(profiles.rows[0]?.cnt).toBe('1');
      expect(profiles.rows[0]?.rule_version).toBe(2);

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

  it('nests safeContext so caller cannot override system audit fields', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
        safeContext: {
          ruleVersion: 999,
          signalState: 'fake',
          score: 999,
        },
      });
      expect(result.snapshot.safeInputs.ruleVersion).toBe(2);
      expect(Array.isArray(result.snapshot.safeInputs.signalState)).toBe(true);
      expect(result.snapshot.safeInputs.context).toEqual({
        ruleVersion: 999,
        signalState: 'fake',
        score: 999,
      });
      expect(result.snapshot.score).toBe(10);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('zero active signals: evaluator/snapshot/profile share NO_ACTIVE_SIGNALS', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        signalFacts: [
          { code: 'ACCOUNT_AGE', active: false, reasonCode: 'ACCOUNT_AGE_OK' },
          { code: 'WALLET_REUSE', active: false, reasonCode: 'WALLET_OK' },
        ],
      });
      expect(result.evaluation.score).toBe(0);
      expect(result.evaluation.riskTier).toBe('LOW');
      expect(result.evaluation.action).toBe('ALLOW');
      expect(result.evaluation.reasonCodes).toEqual(['NO_ACTIVE_SIGNALS']);
      expect(result.snapshot.reasonCodes).toEqual(['NO_ACTIVE_SIGNALS']);
      expect(result.profile.reasonCodes).toEqual(['NO_ACTIVE_SIGNALS']);
      expect(result.snapshot.score).toBe(0);
      expect(result.profile.score).toBe(0);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('failed signal evaluation creates no snapshot/profile mutation', async () => {
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

  it('rejects sensitive safeContext', async () => {
    const client = await pool.connect();
    try {
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
          safeContext: { access_token: 'nope' },
        }),
      ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });
    } finally {
      client.release();
    }
  });

  it('lower-level resolveActiveRiskRuleVersion still accepts explicit historical at', async () => {
    const client = await pool.connect();
    try {
      const historical = await resolveActiveRiskRuleVersion(client, { at: BEFORE_BOUNDARY });
      expect(historical.ruleVersion).toBe(1);
      const current = await resolveActiveRiskRuleVersion(client, { at: AFTER_BOUNDARY });
      expect(current.ruleVersion).toBe(2);
    } finally {
      client.release();
    }
  });
});

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 evaluateAndPersistRisk rule resolution fail-closed', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000015');
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no ACTIVE rule => RISK_RULE_NOT_CONFIGURED and no writes', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 10,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });

    const beforeSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    const beforeProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
        }),
      ).rejects.toMatchObject({ code: 'RISK_RULE_NOT_CONFIGURED' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const afterSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    const afterProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(afterSnaps.rows[0]?.cnt).toBe(beforeSnaps.rows[0]?.cnt);
    expect(afterProfiles.rows[0]?.cnt).toBe(beforeProfiles.rows[0]?.cnt);
  });

  it('future ACTIVE rule only => fail closed before effective_from', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 20,
      status: 'ACTIVE',
      effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      effectiveTo: null,
      signalWeights: SIGNAL_WEIGHTS,
      actions: TEST_ACTIONS,
    });

    const beforeSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );

    useServerTime(new Date('2026-01-01T00:00:00.000Z'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
        }),
      ).rejects.toMatchObject({ code: 'RISK_RULE_NOT_CONFIGURED' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const afterSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(afterSnaps.rows[0]?.cnt).toBe(beforeSnaps.rows[0]?.cnt);
  });

  it('malformed ACTIVE rule => fail closed with no snapshot/profile write', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    // Invalid threshold ordering — stored as JSONB, rejected by resolver config validation.
    await insertRiskRule(pool, {
      ruleVersion: 30,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: { lowMax: 50, mediumMax: 20, highMax: 75 },
      signalWeights: SIGNAL_WEIGHTS,
      actions: TEST_ACTIONS,
    });

    const beforeSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    const beforeProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );

    useServerTime(new Date('2026-01-01T00:00:00.000Z'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          signalFacts: [{ code: 'ACCOUNT_AGE', active: true, reasonCode: 'ACCOUNT_AGE_ACTIVE' }],
        }),
      ).rejects.toBeInstanceOf(FraudDomainError);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const afterSnaps = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_snapshots WHERE user_id = $1::uuid`,
      [userId],
    );
    const afterProfiles = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM risk_profiles WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(afterSnaps.rows[0]?.cnt).toBe(beforeSnaps.rows[0]?.cnt);
    expect(afterProfiles.rows[0]?.cnt).toBe(beforeProfiles.rows[0]?.cnt);
  });
});
