import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

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

const RESTRICT_VIOLATION = '23001';

const ALT_TEST_ELIGIBILITY_POLICY_CONFIG = {
  actions: {
    WITHDRAWAL_REQUEST: {
      requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
      precedence: ['ACCOUNT_STATE', 'RISK_POLICY'],
    },
  },
} as const;

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Eligibility referenced policy semantic immutability',
  () => {
    let pool: Pool;
    let userId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14000092');
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    async function insertReferencedPolicy(policyVersion: number): Promise<{
      decidedAt: Date;
      policyConfig: unknown;
    }> {
      // Status-only supersession keeps EXCLUDE overlap clear for the next ACTIVE fixture.
      await pool.query(
        `UPDATE eligibility_policy_versions
         SET status = 'SUPERSEDED'::rule_version_status
         WHERE status = 'ACTIVE'`,
      );

      await insertEligibilityPolicy(pool, {
        policyVersion,
        status: 'ACTIVE',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        reason: 'phase14-eligibility-ref-immutability',
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
      await pool.query(
        `UPDATE eligibility_policy_versions
         SET audit_reference = $2
         WHERE policy_version = $1`,
        [policyVersion, `audit-ref-${policyVersion}`],
      );

      const client = await pool.connect();
      try {
        const decision = await persistEligibilityDecision(client, {
          userId,
          actionType: 'AD_SESSION_START',
          outcome: 'ELIGIBLE',
          policyVersion,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: { fixture: `ref-${policyVersion}` },
        });
        const row = await client.query<{ policy_config: unknown }>(
          `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
          [policyVersion],
        );
        return {
          decidedAt: decision.decidedAt,
          policyConfig: row.rows[0]?.policy_config,
        };
      } finally {
        client.release();
      }
    }

    it('rejects policy_config rewrite after first decision reference', async () => {
      const policyVersion = 950;
      const before = await insertReferencedPolicy(policyVersion);

      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET policy_config = $2::jsonb
           WHERE policy_version = $1`,
          [policyVersion, JSON.stringify(ALT_TEST_ELIGIBILITY_POLICY_CONFIG)],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      const after = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );
      expect(after.rows[0]?.policy_config).toEqual(before.policyConfig);
    });

    it('rejects effective_from rewrite after reference', async () => {
      const policyVersion = 951;
      await insertReferencedPolicy(policyVersion);
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET effective_from = '2019-01-01T00:00:00.000Z'::timestamptz
           WHERE policy_version = $1`,
          [policyVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('rejects reason and audit_reference rewrite after reference', async () => {
      const policyVersion = 952;
      await insertReferencedPolicy(policyVersion);
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET reason = 'rewritten-reason'
           WHERE policy_version = $1`,
          [policyVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET audit_reference = 'rewritten-audit'
           WHERE policy_version = $1`,
          [policyVersion],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('allows safe first effective_to closure after latest decided_at', async () => {
      const policyVersion = 953;
      const { decidedAt, policyConfig } = await insertReferencedPolicy(policyVersion);
      const closure = new Date(decidedAt.getTime() + 60_000);

      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET effective_to = $2::timestamptz
           WHERE policy_version = $1`,
          [policyVersion, closure.toISOString()],
        ),
      ).resolves.toBeTruthy();

      const row = await pool.query<{
        effective_to: Date;
        policy_config: unknown;
      }>(
        `SELECT effective_to, policy_config
         FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );
      expect(row.rows[0]?.effective_to.toISOString()).toBe(closure.toISOString());
      expect(row.rows[0]?.policy_config).toEqual(policyConfig);
    });

    it('rejects retroactive effective_to at or before decided_at', async () => {
      const policyVersion = 954;
      const { decidedAt } = await insertReferencedPolicy(policyVersion);
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET effective_to = $2::timestamptz
           WHERE policy_version = $1`,
          [policyVersion, decidedAt.toISOString()],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET effective_to = $2::timestamptz
           WHERE policy_version = $1`,
          [policyVersion, new Date(decidedAt.getTime() - 1000).toISOString()],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('rejects second effective_to rewrite after safe closure', async () => {
      const policyVersion = 955;
      const { decidedAt } = await insertReferencedPolicy(policyVersion);
      const firstClose = new Date(decidedAt.getTime() + 60_000);
      await pool.query(
        `UPDATE eligibility_policy_versions
         SET effective_to = $2::timestamptz
         WHERE policy_version = $1`,
        [policyVersion, firstClose.toISOString()],
      );
      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET effective_to = $2::timestamptz
           WHERE policy_version = $1`,
          [policyVersion, new Date(firstClose.getTime() + 60_000).toISOString()],
        ),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    });

    it('allows status-only lifecycle change without rewriting semantics', async () => {
      const policyVersion = 956;
      const before = await insertReferencedPolicy(policyVersion);
      const snap = await pool.query<{
        policy_config: unknown;
        effective_from: Date;
        reason: string | null;
        audit_reference: string | null;
      }>(
        `SELECT policy_config, effective_from, reason, audit_reference
         FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );

      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET status = 'SUPERSEDED'::rule_version_status
           WHERE policy_version = $1`,
          [policyVersion],
        ),
      ).resolves.toBeTruthy();

      const after = await pool.query<{
        status: string;
        policy_config: unknown;
        effective_from: Date;
        reason: string | null;
        audit_reference: string | null;
      }>(
        `SELECT status::text AS status, policy_config, effective_from, reason, audit_reference
         FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );
      expect(after.rows[0]?.status).toBe('SUPERSEDED');
      expect(after.rows[0]?.policy_config).toEqual(before.policyConfig);
      expect(after.rows[0]?.effective_from.toISOString()).toBe(
        snap.rows[0]?.effective_from.toISOString(),
      );
      expect(after.rows[0]?.reason).toBe(snap.rows[0]?.reason);
      expect(after.rows[0]?.audit_reference).toBe(snap.rows[0]?.audit_reference);
    });

    it('rejects DELETE of referenced eligibility policy (FK RESTRICT)', async () => {
      const policyVersion = 957;
      await insertReferencedPolicy(policyVersion);
      await expect(
        pool.query(`DELETE FROM eligibility_policy_versions WHERE policy_version = $1`, [
          policyVersion,
        ]),
      ).rejects.toBeTruthy();

      const stillThere = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );
      expect(stillThere.rows[0]?.c).toBe('1');
    });

    it('allows unreferenced DRAFT policy_config and window edits', async () => {
      await insertEligibilityPolicy(pool, {
        policyVersion: 958,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
        reason: 'draft-authoring',
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });

      await expect(
        pool.query(
          `UPDATE eligibility_policy_versions
           SET policy_config = $1::jsonb,
               reason = 'draft-authoring-revised',
               effective_from = '2026-02-01T00:00:00.000Z'::timestamptz,
               effective_to = '2026-07-01T00:00:00.000Z'::timestamptz
           WHERE policy_version = 958`,
          [JSON.stringify(ALT_TEST_ELIGIBILITY_POLICY_CONFIG)],
        ),
      ).resolves.toBeTruthy();

      const row = await pool.query<{
        reason: string;
        effective_from: Date;
        effective_to: Date;
      }>(
        `SELECT reason, effective_from, effective_to
         FROM eligibility_policy_versions WHERE policy_version = 958`,
      );
      expect(row.rows[0]?.reason).toBe('draft-authoring-revised');
      expect(row.rows[0]?.effective_from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(row.rows[0]?.effective_to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });
  },
);

describe.skipIf(phase14DatabaseUrl === '')(
  'Phase 14 Eligibility first-reference concurrency lock',
  () => {
    let pool: Pool;
    let userId: string;

    beforeAll(async () => {
      await resetAndMigrate(phase14DatabaseUrl);
      pool = createPool(phase14DatabaseUrl);
      userId = await createTestUser(pool, '14000093');
    }, 120_000);

    afterAll(async () => {
      await pool.end();
    });

    async function waitForBlockedOnHolder(
      watcher: PoolClient,
      holderPid: number,
      timeoutMs = 10_000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const waiting = await watcher.query<{ c: number }>(
          `SELECT count(*)::int AS c
           FROM pg_locks blocked
           JOIN pg_locks holder
             ON holder.locktype = blocked.locktype
            AND holder.database IS NOT DISTINCT FROM blocked.database
            AND holder.relation IS NOT DISTINCT FROM blocked.relation
            AND holder.page IS NOT DISTINCT FROM blocked.page
            AND holder.tuple IS NOT DISTINCT FROM blocked.tuple
            AND holder.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
            AND holder.transactionid IS NOT DISTINCT FROM blocked.transactionid
            AND holder.classid IS NOT DISTINCT FROM blocked.classid
            AND holder.objid IS NOT DISTINCT FROM blocked.objid
            AND holder.objsubid IS NOT DISTINCT FROM blocked.objsubid
            AND holder.pid <> blocked.pid
           WHERE NOT blocked.granted
             AND holder.granted
             AND holder.pid = $1`,
          [holderPid],
        );
        if ((waiting.rows[0]?.c ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }

    it('decision-first: open insert FOR SHARE blocks then 0038 rejects concurrent config rewrite', async () => {
      const policyVersion = 970;
      await insertEligibilityPolicy(pool, {
        policyVersion,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        reason: 'phase14-eligibility-ref-lock',
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });

      const original = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await persistEligibilityDecision(clientA, {
          userId,
          actionType: 'AD_SESSION_START',
          outcome: 'ELIGIBLE',
          policyVersion,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: { fixture: 'decision-first' },
        });
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const updatePromise = clientB.query(
          `UPDATE eligibility_policy_versions
           SET policy_config = $1::jsonb
           WHERE policy_version = $2`,
          [JSON.stringify(ALT_TEST_ELIGIBILITY_POLICY_CONFIG), policyVersion],
        );

        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);

        await clientA.query('COMMIT');
        await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

        const after = await pool.query<{ policy_config: unknown; c: string }>(
          `SELECT p.policy_config, (SELECT count(*)::text FROM eligibility_decisions d
             WHERE d.policy_version = p.policy_version) AS c
           FROM eligibility_policy_versions p
           WHERE p.policy_version = $1`,
          [policyVersion],
        );
        expect(after.rows[0]?.c).toBe('1');
        expect(after.rows[0]?.policy_config).toEqual(original.rows[0]?.policy_config);
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

    it('policy-update-first: open config UPDATE blocks decision insert until commit; insert sees new config', async () => {
      const policyVersion = 971;
      await insertEligibilityPolicy(pool, {
        policyVersion,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        reason: 'phase14-eligibility-ref-lock-update-first',
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await clientA.query(
          `UPDATE eligibility_policy_versions
           SET policy_config = $1::jsonb
           WHERE policy_version = $2`,
          [JSON.stringify(ALT_TEST_ELIGIBILITY_POLICY_CONFIG), policyVersion],
        );
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const insertPromise = persistEligibilityDecision(clientB, {
          userId,
          actionType: 'WITHDRAWAL_REQUEST',
          outcome: 'ELIGIBLE',
          policyVersion,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: { fixture: 'update-first' },
        });

        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);

        await clientA.query('COMMIT');
        const decision = await insertPromise;
        expect(decision.policyVersion).toBe(policyVersion);

        const row = await pool.query<{ policy_config: unknown }>(
          `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
          [policyVersion],
        );
        expect(row.rows[0]?.policy_config).toEqual(ALT_TEST_ELIGIBILITY_POLICY_CONFIG);
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

    it('raw INSERT also acquires parent policy FOR SHARE against concurrent config rewrite', async () => {
      const policyVersion = 972;
      await insertEligibilityPolicy(pool, {
        policyVersion,
        status: 'DRAFT',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null,
        reason: 'phase14-eligibility-ref-lock-raw',
        policyConfig: TEST_ELIGIBILITY_POLICY_CONFIG,
      });
      const original = await pool.query<{ policy_config: unknown }>(
        `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
        [policyVersion],
      );

      const digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const clientA = await pool.connect();
      const clientB = await pool.connect();
      const watcher = await pool.connect();
      try {
        await clientA.query('BEGIN');
        await clientA.query(
          `INSERT INTO eligibility_decisions (
             user_id, action_type, outcome, reason_codes, policy_version, inputs_digest, safe_inputs
           ) VALUES (
             $1::uuid, 'AD_SESSION_START'::eligibility_action_type, 'ELIGIBLE'::eligibility_outcome,
             ARRAY['ELIGIBLE_BASELINE']::text[], $2, $3, '{}'::jsonb
           )`,
          [userId, policyVersion, digest],
        );
        const holderPid = (
          await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
        ).rows[0]!.pid;

        const updatePromise = clientB.query(
          `UPDATE eligibility_policy_versions
           SET policy_config = $1::jsonb
           WHERE policy_version = $2`,
          [JSON.stringify(ALT_TEST_ELIGIBILITY_POLICY_CONFIG), policyVersion],
        );

        expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);

        await clientA.query('COMMIT');
        await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

        const after = await pool.query<{ policy_config: unknown }>(
          `SELECT policy_config FROM eligibility_policy_versions WHERE policy_version = $1`,
          [policyVersion],
        );
        expect(after.rows[0]?.policy_config).toEqual(original.rows[0]?.policy_config);
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
