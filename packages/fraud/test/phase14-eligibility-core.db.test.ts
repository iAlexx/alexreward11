import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  computeEligibilityInputsDigest,
  loadEligibilityPolicyVersionByNumber,
  persistEligibilityDecision,
  resolveActiveEligibilityPolicyVersion,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  phase14DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Eligibility policy DB integrity + resolver',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    it('rejects overlapping ACTIVE eligibility policy windows', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 101,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      });
      await expect(
        insertEligibilityPolicy(pool, {
          policyVersion: 102,
          status: 'ACTIVE',
          effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
    });

    it('allows adjacent non-overlapping ACTIVE windows', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 201,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      });
      await expect(
        insertEligibilityPolicy(pool, {
          policyVersion: 202,
          status: 'ACTIVE',
          effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
          effectiveTo: null,
        }),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('allows overlapping DRAFT windows', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 301,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
      });
      await expect(
        insertEligibilityPolicy(pool, {
          policyVersion: 302,
          status: 'DRAFT',
          effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-09-01T00:00:00.000Z'),
        }),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('rejects invalid effective window', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await expect(
        insertEligibilityPolicy(pool, {
          policyVersion: 401,
          status: 'DRAFT',
          effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('enforces unique policy_version', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 501,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      await expect(
        insertEligibilityPolicy(pool, {
          policyVersion: 501,
          status: 'DRAFT',
          effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
          effectiveTo: null,
        }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it('resolves one ACTIVE policy; future/expired excluded; boundary selects new', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      const boundary = new Date('2026-06-01T00:00:00.000Z');
      await insertEligibilityPolicy(pool, {
        policyVersion: 601,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: boundary,
      });
      await insertEligibilityPolicy(pool, {
        policyVersion: 602,
        status: 'ACTIVE',
        effectiveFrom: boundary,
        effectiveTo: null,
      });

      const client = await pool.connect();
      try {
        const mid = await resolveActiveEligibilityPolicyVersion(client, {
          at: new Date('2026-03-01T00:00:00.000Z'),
        });
        expect(mid.policyVersion).toBe(601);

        const atBoundary = await resolveActiveEligibilityPolicyVersion(client, {
          at: boundary,
        });
        expect(atBoundary.policyVersion).toBe(602);

        await expect(
          resolveActiveEligibilityPolicyVersion(client, {
            at: new Date('2025-12-01T00:00:00.000Z'),
          }),
        ).rejects.toMatchObject({ code: 'ELIGIBILITY_POLICY_NOT_CONFIGURED' });
      } finally {
        client.release();
      }
    });

    it('fails closed when no ACTIVE eligibility policy applies', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 701,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      const client = await pool.connect();
      try {
        await expect(resolveActiveEligibilityPolicyVersion(client)).rejects.toMatchObject({
          code: 'ELIGIBILITY_POLICY_NOT_CONFIGURED',
        });
      } finally {
        client.release();
      }
    });

    it('loads historical version by number; missing => NOT_FOUND', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      await insertEligibilityPolicy(pool, {
        policyVersion: 801,
        status: 'SUPERSEDED',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      });
      const client = await pool.connect();
      try {
        const loaded = await loadEligibilityPolicyVersionByNumber(client, 801);
        expect(loaded.policyVersion).toBe(801);
        expect(loaded.status).toBe('SUPERSEDED');
        await expect(loadEligibilityPolicyVersionByNumber(client, 999)).rejects.toMatchObject({
          code: 'ELIGIBILITY_POLICY_NOT_FOUND',
        });
      } finally {
        client.release();
      }
    });

    it('no production eligibility policy seed after migrate', async () => {
      await pool.query(`DELETE FROM eligibility_policy_versions`);
      const empty = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM eligibility_policy_versions`,
      );
      expect(empty.rows[0]?.c).toBe('0');
    });
  },
);

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Eligibility decision persistence', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
    userId = await createTestUser(pool, '14000071');
    await insertEligibilityPolicy(pool, {
      policyVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
    });
    await insertEligibilityPolicy(pool, {
      policyVersion: 2,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      effectiveTo: null,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('rejects new decision with NULL policy_version', async () => {
    await expect(
      pool.query(
        `INSERT INTO eligibility_decisions (
           user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
         ) VALUES (
           $1::uuid, 'AD_SESSION_START'::eligibility_action_type, 'ELIGIBLE'::eligibility_outcome,
           ARRAY['X']::text[], NULL,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           '{}'::jsonb
         )`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects new decision with NULL inputs_digest', async () => {
    await expect(
      pool.query(
        `INSERT INTO eligibility_decisions (
           user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
         ) VALUES (
           $1::uuid, 'AD_SESSION_START'::eligibility_action_type, 'ELIGIBLE'::eligibility_outcome,
           ARRAY['X']::text[], 1, NULL, '{}'::jsonb
         )`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects invalid digest shape', async () => {
    await expect(
      pool.query(
        `INSERT INTO eligibility_decisions (
           user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
         ) VALUES (
           $1::uuid, 'AD_SESSION_START'::eligibility_action_type, 'ELIGIBLE'::eligibility_outcome,
           ARRAY['X']::text[], 1, 'NOT_A_DIGEST', '{}'::jsonb
         )`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects nonexistent policy_version FK', async () => {
    await expect(
      pool.query(
        `INSERT INTO eligibility_decisions (
           user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
         ) VALUES (
           $1::uuid, 'AD_SESSION_START'::eligibility_action_type, 'ELIGIBLE'::eligibility_outcome,
           ARRAY['X']::text[], 999,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           '{}'::jsonb
         )`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION });
  });

  it('persists ELIGIBLE decision; second version preserves first immutable row', async () => {
    const client = await pool.connect();
    try {
      const safeInputs = { fixture: 'eligible-baseline', accountAgeDays: 3 };
      const expectedDigest = computeEligibilityInputsDigest({
        policyVersion: 1,
        userId,
        actionType: 'AD_SESSION_START',
        providerId: null,
        adSessionId: null,
        missionVersionId: null,
        safeInputs,
      });

      const first = await persistEligibilityDecision(client, {
        userId,
        actionType: 'AD_SESSION_START',
        outcome: 'ELIGIBLE',
        policyVersion: 1,
        reasonCodes: ['ELIGIBLE_BASELINE', 'ELIGIBLE_BASELINE'],
        safeInputs,
      });
      expect(first.outcome).toBe('ELIGIBLE');
      expect(first.policyVersion).toBe(1);
      expect(first.reasonCodes).toEqual(['ELIGIBLE_BASELINE']);
      expect(first.inputsDigest).toBe(expectedDigest);
      expect(first.safeInputs).toEqual(safeInputs);
      expect(first.inputsDigest).toMatch(/^[0-9a-f]{64}$/);

      const row = await client.query<{
        action_type: string;
        outcome: string;
        policy_version: number;
        reason_codes: string[];
        inputs_digest: string;
        safe_inputs: Record<string, unknown>;
      }>(
        `SELECT action_type::text AS action_type, outcome::text AS outcome,
                policy_version, reason_codes, inputs_digest, safe_inputs
         FROM eligibility_decisions WHERE id = $1::uuid`,
        [first.id],
      );
      expect(row.rows[0]?.action_type).toBe('AD_SESSION_START');
      expect(row.rows[0]?.outcome).toBe('ELIGIBLE');
      expect(row.rows[0]?.policy_version).toBe(1);
      expect(row.rows[0]?.reason_codes).toEqual(['ELIGIBLE_BASELINE']);
      expect(row.rows[0]?.inputs_digest).toBe(expectedDigest);
      expect(row.rows[0]?.safe_inputs).toEqual(safeInputs);

      const second = await persistEligibilityDecision(client, {
        userId,
        actionType: 'MISSION_CLAIM',
        outcome: 'INELIGIBLE_ACCOUNT_STATE',
        policyVersion: 2,
        reasonCodes: ['ACCOUNT_STATE_BLOCKED'],
        safeInputs: { fixture: 'v2' },
      });
      expect(second.policyVersion).toBe(2);
      expect(second.id).not.toBe(first.id);

      const old = await client.query<{ policy_version: number; outcome: string }>(
        `SELECT policy_version, outcome::text AS outcome
         FROM eligibility_decisions WHERE id = $1::uuid`,
        [first.id],
      );
      expect(old.rows[0]?.policy_version).toBe(1);
      expect(old.rows[0]?.outcome).toBe('ELIGIBLE');

      await expect(
        client.query(`UPDATE eligibility_decisions SET outcome = 'INELIGIBLE_COUNTRY' WHERE id = $1::uuid`, [
          first.id,
        ]),
      ).rejects.toBeTruthy();
      await expect(
        client.query(`DELETE FROM eligibility_decisions WHERE id = $1::uuid`, [first.id]),
      ).rejects.toBeTruthy();

      const ledger = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM ledger_entries`,
      );
      expect(ledger.rows[0]?.cnt).toBe('0');

      const risk = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM risk_snapshots`,
      );
      expect(risk.rows[0]?.cnt).toBe('0');
    } finally {
      client.release();
    }
  });

  it('persist rejects nonexistent policy via application layer', async () => {
    const client = await pool.connect();
    try {
      await expect(
        persistEligibilityDecision(client, {
          userId,
          actionType: 'TASK_CLAIM',
          outcome: 'ELIGIBLE',
          policyVersion: 999,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: {},
        }),
      ).rejects.toMatchObject({ code: 'ELIGIBILITY_POLICY_NOT_FOUND' });
    } finally {
      client.release();
    }
  });
});
