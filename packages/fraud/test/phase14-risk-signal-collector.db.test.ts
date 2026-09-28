import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  collectConfiguredRiskSignals,
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
} from './harness.js';

const SERVER_NOW = new Date('2026-07-01T00:00:00.000Z');

const STEP3_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

/** Explicit TEST-ONLY weights for the seven supported Step 3 signals. */
const STEP3_WEIGHTS = {
  OPEN_HIGH_FRAUD_FLAG: 10,
  OPEN_CRITICAL_FRAUD_FLAG: 25,
  CONFIRMED_FRAUD_FLAG: 40,
  SHARED_PAYOUT_WALLET: 15,
  SHARED_DEVICE_SIGNAL: 12,
  SHARED_NETWORK_SIGNAL: 12,
  NETWORK_COUNTRY_CHANGED: 8,
} as const;

function useServerTime(at: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

async function insertFraudFlag(
  pool: Pool,
  input: {
    userId: string;
    flagType: string;
    severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    status: 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'CONFIRMED';
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const reviewedAt = input.status === 'OPEN' ? null : new Date().toISOString();
  await pool.query(
    `INSERT INTO fraud_flags (user_id, flag_type, severity, status, details, reviewed_at)
     VALUES ($1::uuid, $2, $3::severity_level, $4::fraud_flag_status, $5::jsonb, $6::timestamptz)`,
    [
      input.userId,
      input.flagType,
      input.severity,
      input.status,
      JSON.stringify(input.details ?? { note: 'secret-operator-note' }),
      reviewedAt,
    ],
  );
}

async function insertRelationship(
  pool: Pool,
  input: {
    type: 'SHARED_PAYOUT_WALLET' | 'SHARED_DEVICE_SIGNAL' | 'SHARED_NETWORK_SIGNAL' | 'MANUAL_LINK';
    userId: string;
    relatedUserId: string;
    sharedAddress?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_relationships (
       relationship_type, user_id, related_user_id, shared_address
     ) VALUES (
       $1::wallet_relationship_type, $2::uuid, $3::uuid, $4
     )`,
    [input.type, input.userId, input.relatedUserId, input.sharedAddress ?? null],
  );
}

async function insertNetworkSignal(
  pool: Pool,
  input: {
    userId: string;
    countryCode: string | null;
    observedAt: Date;
    ipHash?: string | null;
    id?: string;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO network_signals (
       id, user_id, signal_type, country_code, ip_hash, observed_at
     ) VALUES (
       COALESCE($1::uuid, app_generate_uuid()), $2::uuid, 'SESSION', $3, $4, $5::timestamptz
     )
     RETURNING id`,
    [
      input.id ?? null,
      input.userId,
      input.countryCode,
      input.ipHash ?? 'ab'.repeat(32),
      input.observedAt.toISOString(),
    ],
  );
  return result.rows[0]!.id;
}

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Step 3 risk signal collector DB', () => {
  let pool: Pool;
  let userId: string;
  let relatedUserId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000030');
    relatedUserId = await createTestUser(pool, '14000031');
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: STEP3_WEIGHTS,
      actions: STEP3_ACTIONS,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    useServerTime(SERVER_NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.query(`DELETE FROM fraud_flags WHERE user_id = $1::uuid`, [userId]);
    await pool.query(
      `DELETE FROM wallet_relationships WHERE user_id = $1::uuid OR related_user_id = $1::uuid`,
      [userId],
    );
    await pool.query(`DELETE FROM network_signals WHERE user_id = $1::uuid`, [userId]);
    // risk_snapshots are append-only; leave historical rows.
    await pool.query(`DELETE FROM risk_profiles WHERE user_id = $1::uuid`, [userId]);
  });

  it('no matching sources => all configured facts inactive with deterministic reasons', async () => {
    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
      const collected = await collectConfiguredRiskSignals(client, { userId, rule });
      expect(collected.signalFacts).toHaveLength(7);
      expect(collected.signalFacts.map((f) => f.code)).toEqual([
        'CONFIRMED_FRAUD_FLAG',
        'NETWORK_COUNTRY_CHANGED',
        'OPEN_CRITICAL_FRAUD_FLAG',
        'OPEN_HIGH_FRAUD_FLAG',
        'SHARED_DEVICE_SIGNAL',
        'SHARED_NETWORK_SIGNAL',
        'SHARED_PAYOUT_WALLET',
      ]);
      expect(collected.signalFacts.every((f) => f.active === false)).toBe(true);
      expect(collected.signalFacts.map((f) => f.reasonCode)).toEqual([
        'NO_CONFIRMED_FRAUD_FLAG',
        'NO_NETWORK_COUNTRY_CHANGE',
        'NO_OPEN_CRITICAL_FRAUD_FLAG',
        'NO_OPEN_HIGH_FRAUD_FLAG',
        'NO_SHARED_DEVICE_SIGNAL',
        'NO_SHARED_NETWORK_SIGNAL',
        'NO_SHARED_PAYOUT_WALLET',
      ]);
    } finally {
      client.release();
    }
  });

  it('fraud flag severity/status mapping', async () => {
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_HIGH',
      severity: 'HIGH',
      status: 'OPEN',
      details: { secret: 'must-not-persist' },
    });
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_CRITICAL',
      severity: 'CRITICAL',
      status: 'OPEN',
    });
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_CONFIRMED',
      severity: 'MEDIUM',
      status: 'CONFIRMED',
    });
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_DISMISSED',
      severity: 'HIGH',
      status: 'DISMISSED',
    });
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_REVIEWED',
      severity: 'CRITICAL',
      status: 'REVIEWED',
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      const byCode = Object.fromEntries(result.signalFacts.map((f) => [f.code, f]));
      expect(byCode.OPEN_HIGH_FRAUD_FLAG?.active).toBe(true);
      expect(byCode.OPEN_CRITICAL_FRAUD_FLAG?.active).toBe(true);
      expect(byCode.CONFIRMED_FRAUD_FLAG?.active).toBe(true);
      expect(byCode.OPEN_HIGH_FRAUD_FLAG?.safeDetails).toEqual({ matchingCount: 1 });
      expect(JSON.stringify(result.snapshot.safeInputs)).not.toContain('must-not-persist');
      expect(JSON.stringify(result.snapshot.safeInputs)).not.toContain('secret');
      expect(result.evaluation.score).toBe(10 + 25 + 40);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('wallet relationships activate only matching types; MANUAL_LINK ignored', async () => {
    await insertRelationship(pool, {
      type: 'SHARED_PAYOUT_WALLET',
      userId,
      relatedUserId,
      sharedAddress: 'EQ_TEST_SHARED_ADDRESS_MUST_NOT_PERSIST',
    });
    await insertRelationship(pool, {
      type: 'SHARED_DEVICE_SIGNAL',
      userId: relatedUserId,
      relatedUserId: userId,
    });
    await insertRelationship(pool, {
      type: 'MANUAL_LINK',
      userId,
      relatedUserId,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      const byCode = Object.fromEntries(result.signalFacts.map((f) => [f.code, f]));
      expect(byCode.SHARED_PAYOUT_WALLET?.active).toBe(true);
      expect(byCode.SHARED_DEVICE_SIGNAL?.active).toBe(true);
      expect(byCode.SHARED_NETWORK_SIGNAL?.active).toBe(false);
      expect(byCode.SHARED_PAYOUT_WALLET?.safeDetails).toEqual({ relationshipCount: 1 });
      const serialized = JSON.stringify(result.snapshot.safeInputs);
      expect(serialized).not.toContain('EQ_TEST_SHARED_ADDRESS_MUST_NOT_PERSIST');
      expect(serialized).not.toContain(relatedUserId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('network country changed uses two latest non-null countries with tie-break id DESC', async () => {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-02-01T00:00:00.000Z');
    const t3 = new Date('2026-02-01T00:00:00.000Z'); // same observed_at as t2

    // 0 observations => inactive
    {
      const client = await pool.connect();
      try {
        const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
        const collected = await collectConfiguredRiskSignals(client, { userId, rule });
        const country = collected.signalFacts.find((f) => f.code === 'NETWORK_COUNTRY_CHANGED')!;
        expect(country.active).toBe(false);
        expect(country.safeDetails).toEqual({
          observationCountConsidered: 0,
          changed: false,
        });
      } finally {
        client.release();
      }
    }

    // 1 observation => inactive
    await insertNetworkSignal(pool, { userId, countryCode: 'US', observedAt: t1 });
    {
      const client = await pool.connect();
      try {
        const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
        const collected = await collectConfiguredRiskSignals(client, { userId, rule });
        const country = collected.signalFacts.find((f) => f.code === 'NETWORK_COUNTRY_CHANGED')!;
        expect(country.active).toBe(false);
        expect(country.safeDetails).toEqual({
          observationCountConsidered: 1,
          changed: false,
        });
      } finally {
        client.release();
      }
    }

    // null country ignored; same country latest two => inactive
    await insertNetworkSignal(pool, {
      userId,
      countryCode: null,
      observedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await insertNetworkSignal(pool, { userId, countryCode: 'US', observedAt: t2, id: '00000000-0000-4000-8000-0000000000aa' });
    {
      const client = await pool.connect();
      try {
        const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
        const collected = await collectConfiguredRiskSignals(client, { userId, rule });
        const country = collected.signalFacts.find((f) => f.code === 'NETWORK_COUNTRY_CHANGED')!;
        expect(country.active).toBe(false);
      } finally {
        client.release();
      }
    }

    // different country with later id at same observed_at => active (id DESC tie-break)
    await insertNetworkSignal(pool, {
      userId,
      countryCode: 'DE',
      observedAt: t3,
      id: '00000000-0000-4000-8000-0000000000ff',
    });
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await evaluateAndPersistRisk(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
        });
        const country = result.signalFacts.find((f) => f.code === 'NETWORK_COUNTRY_CHANGED')!;
        expect(country.active).toBe(true);
        expect(country.safeDetails).toEqual({
          observationCountConsidered: 2,
          changed: true,
        });
        expect(JSON.stringify(result.snapshot.safeInputs)).not.toMatch(/"ip_hash"/);
        expect(JSON.stringify(result.snapshot.safeInputs)).not.toContain('ab'.repeat(32));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  });

  it('unsupported configured signal fails closed with no snapshot/profile write', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 99,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { ACCOUNT_AGE: 10, OPEN_HIGH_FRAUD_FLAG: 5 },
      actions: STEP3_ACTIONS,
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
        }),
      ).rejects.toMatchObject({ code: 'RISK_SIGNAL_COLLECTOR_UNSUPPORTED' });
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

    // Restore Step 3 rule for subsequent isolation (file may continue).
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: STEP3_WEIGHTS,
      actions: STEP3_ACTIONS,
    });
  });

  it('nonexistent user fails closed with RISK_SIGNAL_SOURCE_NOT_FOUND', async () => {
    const client = await pool.connect();
    try {
      await expect(
        evaluateAndPersistRisk(client, {
          userId: '00000000-0000-4000-8000-000000009999',
          decisionScope: 'WITHDRAWAL_REQUEST',
        }),
      ).rejects.toMatchObject({ code: 'RISK_SIGNAL_SOURCE_NOT_FOUND' });
    } finally {
      client.release();
    }
  });

  it('authoritative persistence derives facts from DB only and nests safeContext', async () => {
    await insertFraudFlag(pool, {
      userId,
      flagType: 'TEST_HIGH',
      severity: 'HIGH',
      status: 'OPEN',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        safeContext: {
          signalFacts: [{ code: 'FAKE', active: true }],
          score: 999,
          ruleVersion: 999,
        },
      });
      expect(result.evaluation.score).toBe(10);
      expect(result.snapshot.score).toBe(10);
      expect(result.profile.score).toBe(10);
      expect(result.snapshot.safeInputs.ruleVersion).toBe(1);
      expect(result.snapshot.safeInputs.signalEvidence).toBeTruthy();
      expect(result.snapshot.safeInputs.context).toMatchObject({ score: 999, ruleVersion: 999 });
      expect(result.evaluation.reasonCodes).toEqual(result.snapshot.reasonCodes);
      expect(result.snapshot.reasonCodes).toEqual(result.profile.reasonCodes);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});
