import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  FraudDomainError,
  computeRiskInputsDigest,
  evaluateAndPersistRisk,
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
  waitForBlockedOnHolder,
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

const RESTRICT_VIOLATION = '23001';
const FK_VIOLATION = '23503';

const ALT_RULE_WEIGHTS = {
  ACCOUNT_AGE: 25,
  WALLET_REUSE: 15,
} as const;

const ALT_RULE_THRESHOLDS = {
  lowMax: 15,
  mediumMax: 40,
  highMax: 70,
} as const;

const ALT_RULE_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'MANUAL_REVIEW',
  HIGH: 'HELD',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Risk rule-version reference integrity',
  () => {
    let pool: Pool;
    let userId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14000100');
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    async function insertReferencedRiskRule(ruleVersion: number): Promise<{
      calculatedAt: Date;
      thresholds: unknown;
      signalWeights: unknown;
      actions: unknown;
    }> {
      await pool.query(
        `UPDATE risk_rule_versions
         SET status = 'SUPERSEDED'::rule_version_status
         WHERE status = 'ACTIVE'`,
      );
      await insertRiskRule(pool, {
        ruleVersion,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      await pool.query(
        `UPDATE risk_rule_versions
         SET reason = 'phase14-risk-ref-immutability', audit_reference = $2
         WHERE rule_version = $1`,
        [ruleVersion, `risk-audit-${ruleVersion}`],
      );

      const client = await pool.connect();
      try {
        const snap = await persistRiskSnapshot(client, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
          score: 10,
          riskTier: 'LOW',
          ruleVersion,
          reasonCodes: ['REF_INTEGRITY'],
          safeInputs: { fixture: `risk-${ruleVersion}` },
          outputs: { score: 10 },
        });
        const row = await client.query<{
          thresholds: unknown;
          signal_weights: unknown;
          actions: unknown;
        }>(
          `SELECT thresholds, signal_weights, actions
           FROM risk_rule_versions WHERE rule_version = $1`,
          [ruleVersion],
        );
        return {
          calculatedAt: snap.calculatedAt,
          thresholds: row.rows[0]?.thresholds,
          signalWeights: row.rows[0]?.signal_weights,
          actions: row.rows[0]?.actions,
        };
      } finally {
        client.release();
      }
    }

    it('rejects risk_snapshot with nonexistent rule_version via FK', async () => {
      await expect(
        pool.query(
          `INSERT INTO risk_snapshots (
             user_id, decision_scope, score, risk_tier, rule_version,
             reason_codes, inputs_digest, safe_inputs, outputs
           ) VALUES (
             $1::uuid, 'WITHDRAWAL_REQUEST'::eligibility_action_type, 1, 'LOW'::risk_tier, 99999,
             ARRAY['X']::text[],
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             '{}'::jsonb, '{}'::jsonb
           )`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });

    it('rejects referenced thresholds / signal_weights / actions updates', async () => {
      const ruleVersion = 1010;
      const before = await insertReferencedRiskRule(ruleVersion);

      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET thresholds = $1::jsonb WHERE rule_version = $2`,
          [JSON.stringify(ALT_RULE_THRESHOLDS), ruleVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET signal_weights = $1::jsonb WHERE rule_version = $2`,
          [JSON.stringify(ALT_RULE_WEIGHTS), ruleVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET actions = $1::jsonb WHERE rule_version = $2`,
          [JSON.stringify(ALT_RULE_ACTIONS), ruleVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      const after = await pool.query<{
        thresholds: unknown;
        signal_weights: unknown;
        actions: unknown;
      }>(
        `SELECT thresholds, signal_weights, actions FROM risk_rule_versions WHERE rule_version = $1`,
        [ruleVersion],
      );
      expect(after.rows[0]?.thresholds).toEqual(before.thresholds);
      expect(after.rows[0]?.signal_weights).toEqual(before.signalWeights);
      expect(after.rows[0]?.actions).toEqual(before.actions);
    });

    it('rejects referenced effective_from / reason / audit_reference updates', async () => {
      const ruleVersion = 1011;
      await insertReferencedRiskRule(ruleVersion);
      await expect(
        pool.query(
          `UPDATE risk_rule_versions
           SET effective_from = '2019-01-01T00:00:00.000Z'::timestamptz
           WHERE rule_version = $1`,
          [ruleVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(`UPDATE risk_rule_versions SET reason = 'rewritten' WHERE rule_version = $1`, [
          ruleVersion,
        ]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET audit_reference = 'rewritten' WHERE rule_version = $1`,
          [ruleVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('rejects DELETE of referenced risk rule', async () => {
      const ruleVersion = 1012;
      await insertReferencedRiskRule(ruleVersion);
      await expect(
        pool.query(`DELETE FROM risk_rule_versions WHERE rule_version = $1`, [ruleVersion]),
      ).rejects.toBeTruthy();
      const still = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM risk_rule_versions WHERE rule_version = $1`,
        [ruleVersion],
      );
      expect(still.rows[0]?.c).toBe('1');
    });

    it('allows safe first effective_to closure; rejects retroactive and second rewrite', async () => {
      const ruleVersion = 1013;
      const { calculatedAt, thresholds } = await insertReferencedRiskRule(ruleVersion);
      const closure = new Date(calculatedAt.getTime() + 60_000);
      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
          [ruleVersion, closure.toISOString()],
        ),
      ).resolves.toBeTruthy();
      const row = await pool.query<{ effective_to: Date; thresholds: unknown }>(
        `SELECT effective_to, thresholds FROM risk_rule_versions WHERE rule_version = $1`,
        [ruleVersion],
      );
      expect(row.rows[0]?.effective_to.toISOString()).toBe(closure.toISOString());
      expect(row.rows[0]?.thresholds).toEqual(thresholds);

      const ruleVersion2 = 1014;
      const second = await insertReferencedRiskRule(ruleVersion2);
      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
          [ruleVersion2, second.calculatedAt.toISOString()],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      await expect(
        pool.query(
          `UPDATE risk_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
          [ruleVersion, new Date(closure.getTime() + 60_000).toISOString()],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('allows status-only lifecycle update without rewriting semantics', async () => {
      const ruleVersion = 1015;
      const before = await insertReferencedRiskRule(ruleVersion);
      await expect(
        pool.query(
          `UPDATE risk_rule_versions
           SET status = 'SUPERSEDED'::rule_version_status
           WHERE rule_version = $1`,
          [ruleVersion],
        ),
      ).resolves.toBeTruthy();
      const after = await pool.query<{
        status: string;
        thresholds: unknown;
        signal_weights: unknown;
      }>(
        `SELECT status::text AS status, thresholds, signal_weights
         FROM risk_rule_versions WHERE rule_version = $1`,
        [ruleVersion],
      );
      expect(after.rows[0]?.status).toBe('SUPERSEDED');
      expect(after.rows[0]?.thresholds).toEqual(before.thresholds);
      expect(after.rows[0]?.signal_weights).toEqual(before.signalWeights);
    });

    it('allows unreferenced DRAFT risk rule authoring', async () => {
      await insertRiskRule(pool, {
        ruleVersion: 1016,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      });
      await pool.query(
        `UPDATE risk_rule_versions SET reason = 'draft-authoring' WHERE rule_version = 1016`,
      );
      await expect(
        pool.query(
          `UPDATE risk_rule_versions
           SET thresholds = $1::jsonb,
               signal_weights = $2::jsonb,
               actions = $3::jsonb,
               reason = 'draft-revised',
               effective_from = '2026-02-01T00:00:00.000Z'::timestamptz,
               effective_to = '2026-07-01T00:00:00.000Z'::timestamptz
           WHERE rule_version = 1016`,
          [
            JSON.stringify(ALT_RULE_THRESHOLDS),
            JSON.stringify(ALT_RULE_WEIGHTS),
            JSON.stringify(ALT_RULE_ACTIONS),
          ],
        ),
      ).resolves.toBeTruthy();
    });
  },
);

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Risk first-reference concurrency lock',
  () => {
    let pool: Pool;
    let userId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14000101');
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('evaluation-first: open evaluateAndPersistRisk blocks then rejects concurrent weight rewrite', async () => {
      const step3Weights = { OPEN_HIGH_FRAUD_FLAG: 10, SHARED_PAYOUT_WALLET: 15 } as const;
      const altWeights = { OPEN_HIGH_FRAUD_FLAG: 40, SHARED_PAYOUT_WALLET: 15 } as const;
      await insertRiskRule(pool, {
        ruleVersion: 1020,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        signalWeights: step3Weights,
      });
      const original = await pool.query<{ signal_weights: unknown }>(
        `SELECT signal_weights FROM risk_rule_versions WHERE rule_version = 1020`,
      );

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await evaluateAndPersistRisk(clientA, {
          userId,
          decisionScope: 'WITHDRAWAL_REQUEST',
        });
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const updatePromise = clientB.query(
          `UPDATE risk_rule_versions SET signal_weights = $1::jsonb WHERE rule_version = 1020`,
          [JSON.stringify(altWeights)],
        );
        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);

        await clientA.query('COMMIT');
        await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

        const after = await pool.query<{ signal_weights: unknown }>(
          `SELECT signal_weights FROM risk_rule_versions WHERE rule_version = 1020`,
        );
        expect(after.rows[0]?.signal_weights).toEqual(original.rows[0]?.signal_weights);
      } finally {
        try {
          await clientA.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        clientA.release();
        clientB.release();
        watcher.release();
      }
    }, 60_000);

    it('update-first: open weight UPDATE blocks evaluator; after commit evaluator uses NEW config', async () => {
      const step3Weights = { OPEN_HIGH_FRAUD_FLAG: 10, SHARED_PAYOUT_WALLET: 15 } as const;
      const altWeights = { OPEN_HIGH_FRAUD_FLAG: 40, SHARED_PAYOUT_WALLET: 15 } as const;

      await pool.query(
        `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertRiskRule(pool, {
        ruleVersion: 1021,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        signalWeights: step3Weights,
      });

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await clientA.query(
          `UPDATE risk_rule_versions SET signal_weights = $1::jsonb WHERE rule_version = 1021`,
          [JSON.stringify(altWeights)],
        );
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const evalPromise = (async () => {
          await clientB.query('BEGIN');
          try {
            const result = await evaluateAndPersistRisk(clientB, {
              userId,
              decisionScope: 'AD_SESSION_START',
            });
            await clientB.query('COMMIT');
            return result;
          } catch (e) {
            await clientB.query('ROLLBACK');
            throw e;
          }
        })();

        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);
        await clientA.query('COMMIT');
        const result = await evalPromise;
        expect(result.rule.signalWeights).toEqual(altWeights);
        expect(result.snapshot.ruleVersion).toBe(1021);
      } finally {
        try {
          await clientA.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        try {
          await clientB.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        clientA.release();
        clientB.release();
        watcher.release();
      }
    }, 60_000);

    it('raw risk_snapshot INSERT acquires FOR SHARE against concurrent semantic UPDATE', async () => {
      await pool.query(
        `UPDATE risk_rule_versions SET status = 'SUPERSEDED'::rule_version_status WHERE status = 'ACTIVE'`,
      );
      await insertRiskRule(pool, {
        ruleVersion: 1022,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      const original = await pool.query<{ thresholds: unknown }>(
        `SELECT thresholds FROM risk_rule_versions WHERE rule_version = 1022`,
      );

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await clientA.query(
          `INSERT INTO risk_snapshots (
             user_id, decision_scope, score, risk_tier, rule_version,
             reason_codes, inputs_digest, safe_inputs, outputs
           ) VALUES (
             $1::uuid, 'MISSION_CLAIM'::eligibility_action_type, 5, 'LOW'::risk_tier, 1022,
             ARRAY['RAW']::text[],
             'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
             '{}'::jsonb, '{}'::jsonb
           )`,
          [userId],
        );
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const updatePromise = clientB.query(
          `UPDATE risk_rule_versions SET thresholds = $1::jsonb WHERE rule_version = 1022`,
          [JSON.stringify(ALT_RULE_THRESHOLDS)],
        );
        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);
        await clientA.query('COMMIT');
        await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

        const after = await pool.query<{ thresholds: unknown }>(
          `SELECT thresholds FROM risk_rule_versions WHERE rule_version = 1022`,
        );
        expect(after.rows[0]?.thresholds).toEqual(original.rows[0]?.thresholds);
      } finally {
        try {
          await clientA.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        clientA.release();
        clientB.release();
        watcher.release();
      }
    }, 60_000);
  },
);
