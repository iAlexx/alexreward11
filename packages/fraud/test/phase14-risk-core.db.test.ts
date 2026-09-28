import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  computeRiskInputsDigest,
  loadRiskRuleVersionByNumber,
  persistRiskSnapshot,
  resolveActiveRiskRuleVersion,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertRiskRule,
  phase14DatabaseUrl,
  resetAndMigrate,
  TEST_RULE_ACTIONS,
  TEST_RULE_THRESHOLDS,
  TEST_RULE_WEIGHTS,
} from './harness.js';

const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 risk rule DB integrity + resolver', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('rejects overlapping ACTIVE risk rule windows', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 101,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertRiskRule(pool, {
        ruleVersion: 102,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it('allows adjacent non-overlapping ACTIVE windows', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 201,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertRiskRule(pool, {
        ruleVersion: 202,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows overlapping DRAFT windows', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 301,
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
    });
    await expect(
      insertRiskRule(pool, {
        ruleVersion: 302,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects invalid effective window', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await expect(
      insertRiskRule(pool, {
        ruleVersion: 401,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('resolves one ACTIVE rule and ignores future / expired rows', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 501,
      status: 'ACTIVE',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
    });
    await insertRiskRule(pool, {
      ruleVersion: 502,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
    });
    await insertRiskRule(pool, {
      ruleVersion: 503,
      status: 'ACTIVE',
      effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });

    const client = await pool.connect();
    try {
      const resolved = await resolveActiveRiskRuleVersion(client, {
        at: new Date('2026-06-15T12:00:00.000Z'),
      });
      expect(resolved.ruleVersion).toBe(502);
      expect(resolved.thresholds).toEqual(TEST_RULE_THRESHOLDS);
      expect(resolved.signalWeights).toEqual(TEST_RULE_WEIGHTS);
      expect(resolved.actions).toEqual(TEST_RULE_ACTIONS);

      await expect(
        resolveActiveRiskRuleVersion(client, { at: new Date('2024-01-01T00:00:00.000Z') }),
      ).rejects.toMatchObject({ code: 'RISK_RULE_NOT_CONFIGURED' });
    } finally {
      client.release();
    }
  });

  it('fails closed when no ACTIVE rule applies', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 601,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const client = await pool.connect();
    try {
      await expect(resolveActiveRiskRuleVersion(client)).rejects.toBeInstanceOf(FraudDomainError);
      await expect(resolveActiveRiskRuleVersion(client)).rejects.toMatchObject({
        code: 'RISK_RULE_NOT_CONFIGURED',
      });
    } finally {
      client.release();
    }
  });

  it('fails closed at runtime if multiple ACTIVE rows apply (integrity bypass simulation)', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    // Temporarily drop guard, insert overlap, restore guard, assert resolver fail-closed.
    await pool.query(
      `ALTER TABLE risk_rule_versions DROP CONSTRAINT risk_rule_versions_no_active_overlap`,
    );
    try {
      await insertRiskRule(pool, {
        ruleVersion: 701,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      await insertRiskRule(pool, {
        ruleVersion: 702,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      const client = await pool.connect();
      try {
        await expect(
          resolveActiveRiskRuleVersion(client, { at: new Date('2026-06-01T00:00:00.000Z') }),
        ).rejects.toMatchObject({ code: 'RISK_RULE_INTEGRITY' });
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DELETE FROM risk_rule_versions`);
      await pool.query(`
        ALTER TABLE risk_rule_versions
          ADD CONSTRAINT risk_rule_versions_no_active_overlap
            EXCLUDE USING gist (
              tstzrange(effective_from, effective_to, '[)') WITH &&
            ) WHERE (status = 'ACTIVE')
      `);
    }
  });

  it('loads historical version explicitly; new ACTIVE does not mutate old rows', async () => {
    await pool.query(`DELETE FROM risk_rule_versions`);
    await insertRiskRule(pool, {
      ruleVersion: 801,
      status: 'SUPERSEDED',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      thresholds: { lowMax: 15, mediumMax: 40, highMax: 70 },
    });
    await insertRiskRule(pool, {
      ruleVersion: 802,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      thresholds: { lowMax: 20, mediumMax: 50, highMax: 75 },
    });

    const client = await pool.connect();
    try {
      const historical = await loadRiskRuleVersionByNumber(client, 801);
      expect(historical.thresholds.lowMax).toBe(15);
      expect(historical.status).toBe('SUPERSEDED');

      const active = await resolveActiveRiskRuleVersion(client, {
        at: new Date('2026-02-01T00:00:00.000Z'),
      });
      expect(active.ruleVersion).toBe(802);
      expect(active.thresholds.lowMax).toBe(20);

      const stillHistorical = await loadRiskRuleVersionByNumber(client, 801);
      expect(stillHistorical.thresholds).toEqual({ lowMax: 15, mediumMax: 40, highMax: 70 });
    } finally {
      client.release();
    }
  });
});

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 risk snapshot persistence', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000001');
    await insertRiskRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('writes an immutable snapshot matching server evaluation input', async () => {
    const client = await pool.connect();
    try {
      const safeInputs = { withdrawalId: 'wd-test', accountState: 'ACTIVE', ip_hash: 'ab'.repeat(32) };
      const expectedDigest = computeRiskInputsDigest(1, safeInputs);
      const snapshot = await persistRiskSnapshot(client, {
        userId,
        decisionScope: 'WITHDRAWAL_REQUEST',
        score: 42,
        riskTier: 'MEDIUM',
        ruleVersion: 1,
        reasonCodes: ['TEST_FIXTURE_REASON'],
        safeInputs,
        outputs: { decision: 'MANUAL_REVIEW', neverAutoApprove: true },
      });
      expect(snapshot.score).toBe(42);
      expect(snapshot.riskTier).toBe('MEDIUM');
      expect(snapshot.ruleVersion).toBe(1);
      expect(snapshot.reasonCodes).toEqual(['TEST_FIXTURE_REASON']);
      expect(snapshot.inputsDigest).toBe(expectedDigest);

      const stored = await client.query<{
        score: number;
        risk_tier: string;
        rule_version: number;
        reason_codes: string[];
        inputs_digest: string | null;
      }>(
        `SELECT score, risk_tier::text AS risk_tier, rule_version, reason_codes, inputs_digest
         FROM risk_snapshots WHERE id = $1::uuid`,
        [snapshot.id],
      );
      expect(stored.rows[0]?.score).toBe(42);
      expect(stored.rows[0]?.risk_tier).toBe('MEDIUM');
      expect(stored.rows[0]?.rule_version).toBe(1);
      expect(stored.rows[0]?.reason_codes).toEqual(['TEST_FIXTURE_REASON']);
      expect(stored.rows[0]?.inputs_digest).toBe(expectedDigest);

      await expect(
        client.query(`UPDATE risk_snapshots SET score = 1 WHERE id = $1::uuid`, [snapshot.id]),
      ).rejects.toBeTruthy();
      await expect(
        client.query(`DELETE FROM risk_snapshots WHERE id = $1::uuid`, [snapshot.id]),
      ).rejects.toBeTruthy();
    } finally {
      client.release();
    }
  });

  it('rejects unsafe snapshot payloads in safeInputs and outputs', async () => {
    const client = await pool.connect();
    try {
      await expect(
        persistRiskSnapshot(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          score: 10,
          riskTier: 'LOW',
          ruleVersion: 1,
          reasonCodes: ['TEST_FIXTURE_REASON'],
          safeInputs: { exact_ip: '1.2.3.4' },
          outputs: {},
        }),
      ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });

      await expect(
        persistRiskSnapshot(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          score: 10,
          riskTier: 'LOW',
          ruleVersion: 1,
          reasonCodes: ['TEST_FIXTURE_REASON'],
          safeInputs: { ok: true },
          outputs: { access_token: 'leak' },
        }),
      ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });

      await expect(
        persistRiskSnapshot(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          score: 10,
          riskTier: 'LOW',
          ruleVersion: 1,
          reasonCodes: ['TEST_FIXTURE_REASON'],
          safeInputs: { when: new Date() as unknown as string },
          outputs: {},
        }),
      ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });
    } finally {
      client.release();
    }
  });
});
