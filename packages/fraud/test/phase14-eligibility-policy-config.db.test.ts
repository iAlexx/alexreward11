import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  persistEligibilityDecision,
  resolveActiveEligibilityPolicyVersion,
} from '../src/index.js';
import {
  TEST_ELIGIBILITY_POLICY_CONFIG,
  createPool,
  createTestUser,
  insertEligibilityPolicy,
  phase14DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const CHECK_VIOLATION = '23514';

describe.skipIf(phase14DatabaseUrl === '')('Phase 14 Eligibility policy_config DB', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase14DatabaseUrl);
    pool = createPool(phase14DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('rejects new ACTIVE policy with NULL policy_config', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 901,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        policyConfig: null,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('allows DRAFT policy with NULL policy_config', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 902,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        policyConfig: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects non-object policy_config', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 903,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        policyConfig: ['not', 'an', 'object'],
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('allows valid TEST config on ACTIVE; no production seed', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 904,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    const empty = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM eligibility_policy_versions
       WHERE reason IS DISTINCT FROM 'phase14-eligibility-test-only'`,
    );
    expect(empty.rows[0]?.c).toBe('0');
  });

  it('preserves ACTIVE overlap / adjacent window integrity', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await insertEligibilityPolicy(pool, {
      policyVersion: 910,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
      policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
    });
    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 911,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      }),
    ).rejects.toMatchObject({ code: '23P01' });

    await expect(
      insertEligibilityPolicy(pool, {
        policyVersion: 912,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: null,
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('resolves ACTIVE with valid config; rejects ACTIVE with malformed config', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await insertEligibilityPolicy(pool, {
      policyVersion: 920,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
    });

    const client = await pool.connect();
    try {
      const resolved = await resolveActiveEligibilityPolicyVersion(client, {
        at: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(resolved.status).toBe('ACTIVE');
      expect(resolved.policyConfig.actions.WITHDRAWAL_REQUEST?.requiredGates).toContain(
        'RISK_POLICY',
      );
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await insertEligibilityPolicy(pool, {
      policyVersion: 921,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      policyConfig: { actions: {} },
    });
    const client2 = await pool.connect();
    try {
      await expect(resolveActiveEligibilityPolicyVersion(client2)).rejects.toMatchObject({
        code: 'ELIGIBILITY_POLICY_CONFIG_INVALID',
      });
    } finally {
      client2.release();
    }
  });

  it('fails closed resolving historical ACTIVE NULL config when constructible', async () => {
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    await pool.query(
      `ALTER TABLE eligibility_policy_versions
         DROP CONSTRAINT IF EXISTS eligibility_policy_versions_active_config_required`,
    );
    await pool.query(
      `INSERT INTO eligibility_policy_versions (
         policy_version, status, effective_from, effective_to, reason, policy_config
       ) VALUES (
         930, 'ACTIVE'::rule_version_status, '2020-01-01'::timestamptz, NULL,
         'phase14-eligibility-test-only-null-config', NULL
       )`,
    );
    await pool.query(
      `ALTER TABLE eligibility_policy_versions
         ADD CONSTRAINT eligibility_policy_versions_active_config_required
         CHECK (status <> 'ACTIVE' OR policy_config IS NOT NULL) NOT VALID`,
    );

    const client = await pool.connect();
    try {
      await expect(resolveActiveEligibilityPolicyVersion(client)).rejects.toMatchObject({
        code: 'ELIGIBILITY_POLICY_CONFIG_INVALID',
      });
    } finally {
      client.release();
    }
  });

  it('new decision persistence requires valid policy_config', async () => {
    await pool.query(`DELETE FROM eligibility_decisions`);
    await pool.query(`DELETE FROM eligibility_policy_versions`);
    const userId = await createTestUser(pool, '14000091');

    await insertEligibilityPolicy(pool, {
      policyVersion: 940,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      policyConfig: null,
    });

    const client = await pool.connect();
    try {
      await expect(
        persistEligibilityDecision(client, {
          userId,
          actionType: 'AD_SESSION_START',
          outcome: 'ELIGIBLE',
          policyVersion: 940,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: { fixture: true },
        }),
      ).rejects.toMatchObject({ code: 'ELIGIBILITY_POLICY_CONFIG_INVALID' });
    } finally {
      client.release();
    }

    await insertEligibilityPolicy(pool, {
      policyVersion: 941,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
    });

    const client2 = await pool.connect();
    try {
      const persisted = await persistEligibilityDecision(client2, {
        userId,
        actionType: 'AD_SESSION_START',
        outcome: 'ELIGIBLE',
        policyVersion: 941,
        reasonCodes: ['ELIGIBLE_BASELINE'],
        safeInputs: { fixture: true },
      });
      expect(persisted.policyVersion).toBe(941);
    } finally {
      client2.release();
    }
  });
});
