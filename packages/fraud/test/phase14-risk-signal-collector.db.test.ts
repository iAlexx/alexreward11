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
    await pool.query(`DELETE FROM user_wallets WHERE user_id = $1::uuid OR user_id = $2::uuid`, [
      userId,
      relatedUserId,
    ]);
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

  it('wallet relationships: device/network still use table; stale SHARED_PAYOUT ignored', async () => {
    // Stale payout relationship row must NOT activate SHARED_PAYOUT_WALLET.
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
      expect(byCode.SHARED_PAYOUT_WALLET?.active).toBe(false);
      expect(byCode.SHARED_PAYOUT_WALLET?.safeDetails).toEqual({ relatedAccountCount: 0 });
      expect(byCode.SHARED_DEVICE_SIGNAL?.active).toBe(true);
      expect(byCode.SHARED_NETWORK_SIGNAL?.active).toBe(false);
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
    await pool.query(
      `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
    );
    await insertRiskRule(pool, {
      ruleVersion: 99099,
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

    // Restore an ACTIVE Step 3 rule for subsequent isolation (file may continue).
    await pool.query(
      `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
    );
    await insertRiskRule(pool, {
      ruleVersion: 99100,
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
      expect(result.snapshot.safeInputs.ruleVersion).toBe(result.rule.ruleVersion);
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

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Step 4 live primary payout-wallet reuse', () => {
  let pool: Pool;
  let userA: string;
  let userB: string;
  let userC: string;
  let networkN1: string;
  let networkN2: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userA = await createTestUser(pool, '14000040');
    userB = await createTestUser(pool, '14000041');
    userC = await createTestUser(pool, '14000042');

    networkN1 = (
      await pool.query<{ id: string }>(`SELECT id FROM networks WHERE code = 'TON_TESTNET' LIMIT 1`)
    ).rows[0]!.id;
    networkN2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO networks (
           code, chain, environment, display_name, global_chain_identifier, status
         ) VALUES (
           'TON_TESTNET_B', 'TON', 'TESTNET', 'TON Testnet B (TEST)', 'ton:testnet-b', 'ACTIVE'
         )
         RETURNING id`,
      )
    ).rows[0]!.id;

    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { SHARED_PAYOUT_WALLET: 15 },
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
    await pool.query(
      `DELETE FROM user_wallets WHERE user_id = ANY($1::uuid[])`,
      [[userA, userB, userC]],
    );
    await pool.query(
      `DELETE FROM wallet_relationships WHERE user_id = ANY($1::uuid[]) OR related_user_id = ANY($1::uuid[])`,
      [[userA, userB, userC]],
    );
    await pool.query(`DELETE FROM risk_profiles WHERE user_id = ANY($1::uuid[])`, [
      [userA, userB, userC],
    ]);
  });

  async function insertWallet(input: {
    userId: string;
    networkId: string;
    rawAddress: string;
    friendlyAddress: string;
    isPrimary: boolean;
    verified: boolean;
    disabledAt?: Date | null;
  }): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at, disabled_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, $4,
         $5, $6,
         CASE WHEN $6 THEN 'TON_PROOF'::wallet_verification_method ELSE NULL END,
         CASE WHEN $6 THEN now() ELSE NULL END,
         CASE WHEN $5 THEN now() ELSE NULL END,
         $7::timestamptz
       )
       RETURNING id`,
      [
        input.userId,
        input.networkId,
        input.rawAddress,
        input.friendlyAddress,
        input.isPrimary,
        input.verified,
        input.disabledAt === undefined || input.disabledAt === null
          ? null
          : input.disabledAt.toISOString(),
      ],
    );
    return result.rows[0]!.id;
  }

  async function payoutFact(userId: string) {
    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
      const collected = await collectConfiguredRiskSignals(client, { userId, rule });
      return collected.signalFacts.find((f) => f.code === 'SHARED_PAYOUT_WALLET')!;
    } finally {
      client.release();
    }
  }

  it('verified primary reuse activates for both users with relatedAccountCount=1', async () => {
    const raw = '0:sharedprimaryaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_SHARED',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_SHARED',
      isPrimary: true,
      verified: true,
    });

    const factA = await payoutFact(userA);
    const factB = await payoutFact(userB);
    expect(factA.active).toBe(true);
    expect(factB.active).toBe(true);
    expect(factA.safeDetails).toEqual({ relatedAccountCount: 1 });
    expect(factB.safeDetails).toEqual({ relatedAccountCount: 1 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId: userA,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      expect(result.evaluation.score).toBe(15);
      const serialized = JSON.stringify(result.snapshot.safeInputs);
      expect(serialized).not.toContain(raw);
      expect(serialized).not.toContain('EQ_A_SHARED');
      expect(serialized).not.toContain('EQ_B_SHARED');
      expect(serialized).not.toContain(userB);
      expect(serialized).not.toContain(networkN1);
      expect(serialized).not.toMatch(/"raw_address"/);
      expect(serialized).not.toMatch(/"friendly_address"/);
      expect(serialized).not.toMatch(/"network_id"/);
      expect(result.signalFacts[0]?.safeDetails).toEqual({ relatedAccountCount: 1 });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('non-primary matching wallet does not count until promoted to primary', async () => {
    const raw = '0:nonprimaryaaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_NP',
      isPrimary: true,
      verified: true,
    });
    const bWalletId = await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_NP',
      isPrimary: false,
      verified: true,
    });
    expect((await payoutFact(userA)).active).toBe(false);

    await pool.query(
      `UPDATE user_wallets
       SET is_primary = true, became_primary_at = now()
       WHERE id = $1::uuid`,
      [bWalletId],
    );
    expect((await payoutFact(userA)).active).toBe(true);
    expect((await payoutFact(userA)).safeDetails).toEqual({ relatedAccountCount: 1 });
  });

  it('unverified matching primary does not count', async () => {
    const raw = '0:unverifiedaaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_UV',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_UV',
      isPrimary: true,
      verified: false,
    });
    expect((await payoutFact(userA)).active).toBe(false);
  });

  it('disabled matching primary does not count', async () => {
    const raw = '0:disabledaaaaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_DIS',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_DIS',
      isPrimary: true,
      verified: true,
      disabledAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect((await payoutFact(userA)).active).toBe(false);
  });

  it('same raw_address on different networks does not count', async () => {
    const raw = '0:crossnetworkaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_XN',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN2,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_XN',
      isPrimary: true,
      verified: true,
    });
    expect((await payoutFact(userA)).active).toBe(false);
  });

  it('different address on same network does not count', async () => {
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: '0:diffaddr_aaaaaaaaabbbbbbbbbccccccccdddddddd',
      friendlyAddress: 'EQ_A_DIFF',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: '0:diffaddr_bbbbbbbbbaaaaaaaaaccccccccdddddddd',
      friendlyAddress: 'EQ_B_DIFF',
      isPrimary: true,
      verified: true,
    });
    expect((await payoutFact(userA)).active).toBe(false);
  });

  it('same user does not self-match', async () => {
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: '0:selfmatchaaaaaaaaaabbbbbbbbbccccccccdddddddd',
      friendlyAddress: 'EQ_A_SELF',
      isPrimary: true,
      verified: true,
    });
    expect((await payoutFact(userA)).active).toBe(false);
    expect((await payoutFact(userA)).safeDetails).toEqual({ relatedAccountCount: 0 });
  });

  it('distinct relatedAccountCount; weight applied once', async () => {
    const raw1 = '0:distinct1aaaaaaaaaabbbbbbbbbccccccccdddddddd';
    const raw2 = '0:distinct2aaaaaaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw1,
      friendlyAddress: 'EQ_A_D1',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userA,
      networkId: networkN2,
      rawAddress: raw2,
      friendlyAddress: 'EQ_A_D2',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw1,
      friendlyAddress: 'EQ_B_D1',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN2,
      rawAddress: raw2,
      friendlyAddress: 'EQ_B_D2',
      isPrimary: true,
      verified: true,
    });
    expect((await payoutFact(userA)).safeDetails).toEqual({ relatedAccountCount: 1 });

    await insertWallet({
      userId: userC,
      networkId: networkN1,
      rawAddress: raw1,
      friendlyAddress: 'EQ_C_D1',
      isPrimary: true,
      verified: true,
    });
    const fact = await payoutFact(userA);
    expect(fact.safeDetails).toEqual({ relatedAccountCount: 2 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId: userA,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      expect(result.evaluation.score).toBe(15);
      expect(result.evaluation.contributions).toEqual([
        {
          code: 'SHARED_PAYOUT_WALLET',
          active: true,
          configuredWeight: 15,
          contribution: 15,
        },
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('stale wallet_relationships ignored; live user_wallets activates without relationship row', async () => {
    await insertRelationship(pool, {
      type: 'SHARED_PAYOUT_WALLET',
      userId: userA,
      relatedUserId: userB,
      sharedAddress: 'EQ_STALE_MUST_NOT_ACTIVATE',
    });
    // No matching current primary wallets yet.
    expect((await payoutFact(userA)).active).toBe(false);

    const raw = '0:livewallettruthaaaaabbbbbbbbbccccccccdddddddd';
    await insertWallet({
      userId: userA,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_A_LIVE',
      isPrimary: true,
      verified: true,
    });
    await insertWallet({
      userId: userB,
      networkId: networkN1,
      rawAddress: raw,
      friendlyAddress: 'EQ_B_LIVE',
      isPrimary: true,
      verified: true,
    });
    // Active from live wallets; no new relationship row required.
    const relCount = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM wallet_relationships
       WHERE relationship_type = 'SHARED_PAYOUT_WALLET'
         AND (user_id = $1::uuid OR related_user_id = $1::uuid)`,
      [userA],
    );
    expect(relCount.rows[0]?.cnt).toBe('1'); // only the stale fixture row
    expect((await payoutFact(userA)).active).toBe(true);
    expect((await payoutFact(userA)).safeDetails).toEqual({ relatedAccountCount: 1 });
  });

  it('SHARED_DEVICE_SIGNAL still uses wallet_relationships; SHARED_NETWORK ignores relationship rows', async () => {
    await pool.query(
      `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
    );
    await insertRiskRule(pool, {
      ruleVersion: 99101,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: {
        SHARED_PAYOUT_WALLET: 15,
        SHARED_DEVICE_SIGNAL: 12,
        SHARED_NETWORK_SIGNAL: 12,
      },
      actions: STEP3_ACTIONS,
    });

    await insertRelationship(pool, {
      type: 'SHARED_DEVICE_SIGNAL',
      userId: userA,
      relatedUserId: userB,
    });
    await insertRelationship(pool, {
      type: 'SHARED_NETWORK_SIGNAL',
      userId: userA,
      relatedUserId: userC,
    });

    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
      const collected = await collectConfiguredRiskSignals(client, { userId: userA, rule });
      const byCode = Object.fromEntries(collected.signalFacts.map((f) => [f.code, f]));
      expect(byCode.SHARED_PAYOUT_WALLET?.active).toBe(false);
      expect(byCode.SHARED_DEVICE_SIGNAL?.active).toBe(true);
      // Stale SHARED_NETWORK_SIGNAL relationship row must not activate session-based signal.
      expect(byCode.SHARED_NETWORK_SIGNAL?.active).toBe(false);
      expect(byCode.SHARED_NETWORK_SIGNAL?.safeDetails).toEqual({ relatedAccountCount: 0 });
    } finally {
      client.release();
    }

    // Restore an ACTIVE payout-wallet rule for other tests.
    await pool.query(
      `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
    );
    await insertRiskRule(pool, {
      ruleVersion: 99102,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { SHARED_PAYOUT_WALLET: 15 },
      actions: STEP3_ACTIONS,
    });
  });
});

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Step 5 live shared network from session truth', () => {
  let pool: Pool;
  let userA: string;
  let userB: string;
  let userC: string;
  let sessionSeq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userA = await createTestUser(pool, '14000050');
    userB = await createTestUser(pool, '14000051');
    userC = await createTestUser(pool, '14000052');
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: TEST_RULE_THRESHOLDS,
      signalWeights: { SHARED_NETWORK_SIGNAL: 12 },
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
    await pool.query(`DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])`, [
      [userA, userB, userC],
    ]);
    await pool.query(
      `DELETE FROM wallet_relationships WHERE user_id = ANY($1::uuid[]) OR related_user_id = ANY($1::uuid[])`,
      [[userA, userB, userC]],
    );
    await pool.query(`DELETE FROM risk_profiles WHERE user_id = ANY($1::uuid[])`, [
      [userA, userB, userC],
    ]);
  });

  async function insertSession(input: {
    userId: string;
    ipHash: string | null;
    expiresAt: Date;
    createdAt?: Date;
    revokedAt?: Date | null;
    revokedReason?: 'USER_LOGOUT' | 'ROTATED' | 'EXPIRED' | 'ADMIN_REVOKED' | 'SECURITY_EVENT' | null;
  }): Promise<string> {
    sessionSeq += 1;
    const secretHash = `sess_secret_${sessionSeq}_${input.userId.slice(0, 8)}`;
    const refreshHash = `sess_refresh_${sessionSeq}_${input.userId.slice(0, 8)}`;
    const createdAt = input.createdAt ?? new Date('2026-01-01T00:00:00.000Z');
    const result = await pool.query<{ id: string }>(
      `INSERT INTO user_sessions (
         user_id, session_secret_hash, refresh_token_hash, ip_hash,
         created_at, last_seen_at, expires_at, revoked_at, revoked_reason
       ) VALUES (
         $1::uuid, $2, $3, $4,
         $5::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz,
         $8::session_revocation_reason
       )
       RETURNING id`,
      [
        input.userId,
        secretHash,
        refreshHash,
        input.ipHash,
        createdAt.toISOString(),
        input.expiresAt.toISOString(),
        input.revokedAt === undefined || input.revokedAt === null
          ? null
          : input.revokedAt.toISOString(),
        input.revokedReason ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  async function networkFact(userId: string) {
    const client = await pool.connect();
    try {
      const rule = await resolveActiveRiskRuleVersion(client, { at: SERVER_NOW });
      const collected = await collectConfiguredRiskSignals(client, { userId, rule });
      return collected.signalFacts.find((f) => f.code === 'SHARED_NETWORK_SIGNAL')!;
    } finally {
      client.release();
    }
  }

  const FUTURE = new Date('2099-01-01T00:00:00.000Z');
  const PAST_CREATED = new Date('2020-01-01T00:00:00.000Z');
  const PAST_EXPIRED = new Date('2020-06-01T00:00:00.000Z');
  const HASH_X = 'aa'.repeat(32);
  const HASH_Y = 'bb'.repeat(32);

  it('two active sessions / different users / same hash => active', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: HASH_X, expiresAt: FUTURE });
    const factA = await networkFact(userA);
    const factB = await networkFact(userB);
    expect(factA.active).toBe(true);
    expect(factB.active).toBe(true);
    expect(factA.safeDetails).toEqual({ relatedAccountCount: 1 });
    expect(factB.safeDetails).toEqual({ relatedAccountCount: 1 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId: userA,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      expect(result.evaluation.score).toBe(12);
      const serialized = JSON.stringify(result.snapshot.safeInputs);
      expect(serialized).not.toContain(HASH_X);
      expect(serialized).not.toMatch(/"ip_hash"/);
      expect(serialized).not.toContain(userB);
      expect(serialized).not.toMatch(/"session_secret_hash"/);
      expect(serialized).not.toMatch(/"refresh_token_hash"/);
      expect(result.signalFacts[0]?.safeDetails).toEqual({ relatedAccountCount: 1 });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('same user multiple sessions / same hash => inactive', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    const fact = await networkFact(userA);
    expect(fact.active).toBe(false);
    expect(fact.safeDetails).toEqual({ relatedAccountCount: 0 });
  });

  it('different users / different hashes => inactive', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: HASH_Y, expiresAt: FUTURE });
    expect((await networkFact(userA)).active).toBe(false);
  });

  it('other user matching session expired => inactive', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({
      userId: userB,
      ipHash: HASH_X,
      createdAt: PAST_CREATED,
      expiresAt: PAST_EXPIRED,
    });
    expect((await networkFact(userA)).active).toBe(false);
  });

  it('other user matching session revoked => inactive', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({
      userId: userB,
      ipHash: HASH_X,
      expiresAt: FUTURE,
      revokedAt: new Date('2026-06-01T00:00:00.000Z'),
      revokedReason: 'USER_LOGOUT',
    });
    expect((await networkFact(userA)).active).toBe(false);
  });

  it('null ip_hash sessions never match', async () => {
    await insertSession({ userId: userA, ipHash: null, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: null, expiresAt: FUTURE });
    expect((await networkFact(userA)).active).toBe(false);
  });

  it('distinct relatedAccountCount; weight applied once; multi-session same other user counts once', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userA, ipHash: HASH_Y, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: HASH_Y, expiresAt: FUTURE });
    expect((await networkFact(userA)).safeDetails).toEqual({ relatedAccountCount: 1 });

    await insertSession({ userId: userC, ipHash: HASH_X, expiresAt: FUTURE });
    const fact = await networkFact(userA);
    expect(fact.safeDetails).toEqual({ relatedAccountCount: 2 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await evaluateAndPersistRisk(client, {
        userId: userA,
        decisionScope: 'WITHDRAWAL_REQUEST',
      });
      expect(result.evaluation.score).toBe(12);
      expect(result.evaluation.contributions).toEqual([
        {
          code: 'SHARED_NETWORK_SIGNAL',
          active: true,
          configuredWeight: 12,
          contribution: 12,
        },
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('revoking other user matching session clears signal without cache', async () => {
    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    const bSessionId = await insertSession({
      userId: userB,
      ipHash: HASH_X,
      expiresAt: FUTURE,
    });
    expect((await networkFact(userA)).active).toBe(true);

    await pool.query(
      `UPDATE user_sessions
       SET revoked_at = now(), revoked_reason = 'USER_LOGOUT'::session_revocation_reason
       WHERE id = $1::uuid`,
      [bSessionId],
    );
    expect((await networkFact(userA)).active).toBe(false);
  });

  it('stale SHARED_NETWORK wallet_relationship ignored; live sessions activate without relationship row', async () => {
    await insertRelationship(pool, {
      type: 'SHARED_NETWORK_SIGNAL',
      userId: userA,
      relatedUserId: userB,
    });
    expect((await networkFact(userA)).active).toBe(false);

    await insertSession({ userId: userA, ipHash: HASH_X, expiresAt: FUTURE });
    await insertSession({ userId: userB, ipHash: HASH_X, expiresAt: FUTURE });
    const relCount = await pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM wallet_relationships
       WHERE relationship_type = 'SHARED_NETWORK_SIGNAL'
         AND (user_id = $1::uuid OR related_user_id = $1::uuid)`,
      [userA],
    );
    expect(relCount.rows[0]?.cnt).toBe('1'); // stale fixture only
    expect((await networkFact(userA)).active).toBe(true);
    expect((await networkFact(userA)).safeDetails).toEqual({ relatedAccountCount: 1 });
  });
});
