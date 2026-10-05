import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  ReferralDomainError,
  loadReferralRuleVersionByNumber,
  resolveActiveReferralRuleVersion,
  resolveActiveReferralRuleVersionForEvaluation,
} from '../src/index.js';
import {
  TEST_REFERRAL_BASE_RATE_BPS,
  createPool,
  createTestUser,
  insertPendingEdge,
  insertReferralCode,
  insertReferralRule,
  phase15DatabaseUrl,
  resetAndMigrate,
  waitForBlockedOnHolder,
} from './harness.js';

const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const FK_VIOLATION = '23503';

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 referral rule DB integrity + resolver', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('rejects overlapping ACTIVE referral rule windows', async () => {
    await pool.query(`DELETE FROM referral_rule_versions`);
    await insertReferralRule(pool, {
      ruleVersion: 101,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertReferralRule(pool, {
        ruleVersion: 102,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it('allows adjacent non-overlapping ACTIVE windows and overlapping DRAFT', async () => {
    await pool.query(`DELETE FROM referral_rule_versions`);
    await insertReferralRule(pool, {
      ruleVersion: 201,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertReferralRule(pool, {
        ruleVersion: 202,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    await insertReferralRule(pool, {
      ruleVersion: 301,
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
    });
    await expect(
      insertReferralRule(pool, {
        ruleVersion: 302,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects invalid effective window and freezes economics after insert', async () => {
    await pool.query(`DELETE FROM referral_rule_versions`);
    await expect(
      insertReferralRule(pool, {
        ruleVersion: 401,
        status: 'DRAFT',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await insertReferralRule(pool, {
      ruleVersion: 402,
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      baseRateBps: TEST_REFERRAL_BASE_RATE_BPS,
    });
    await expect(
      pool.query(`UPDATE referral_rule_versions SET base_rate_bps = 999 WHERE rule_version = 402`),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE referral_rule_versions SET activation_account_age_seconds = 9 WHERE rule_version = 402`,
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE referral_rule_versions SET reason = 'draft-note', source_reference = 'src' WHERE rule_version = 402`,
      ),
    ).resolves.toBeTruthy();
  });

  it('resolves one ACTIVE rule and fails closed on zero / ambiguous', async () => {
    await pool.query(`DELETE FROM referral_rule_versions`);
    await insertReferralRule(pool, {
      ruleVersion: 501,
      status: 'ACTIVE',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
    });
    await insertReferralRule(pool, {
      ruleVersion: 502,
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
      baseRateBps: 234,
    });

    const client = await pool.connect();
    try {
      const resolved = await resolveActiveReferralRuleVersion(client, {
        at: new Date('2026-06-15T12:00:00.000Z'),
      });
      expect(resolved.ruleVersion).toBe(502);
      expect(resolved.baseRateBps).toBe(234);

      await expect(
        resolveActiveReferralRuleVersion(client, { at: new Date('2024-01-01T00:00:00.000Z') }),
      ).rejects.toMatchObject({ code: 'REFERRAL_RULE_NOT_CONFIGURED' });
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM referral_rule_versions`);
    await insertReferralRule(pool, {
      ruleVersion: 601,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const client2 = await pool.connect();
    try {
      await expect(resolveActiveReferralRuleVersion(client2)).rejects.toBeInstanceOf(
        ReferralDomainError,
      );
      await expect(resolveActiveReferralRuleVersion(client2)).rejects.toMatchObject({
        code: 'REFERRAL_RULE_NOT_CONFIGURED',
      });
    } finally {
      client2.release();
    }

    await pool.query(`DELETE FROM referral_rule_versions`);
    await pool.query(
      `ALTER TABLE referral_rule_versions DROP CONSTRAINT referral_rule_versions_no_active_overlap`,
    );
    try {
      await insertReferralRule(pool, {
        ruleVersion: 701,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      await insertReferralRule(pool, {
        ruleVersion: 702,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      });
      const client3 = await pool.connect();
      try {
        await expect(
          resolveActiveReferralRuleVersion(client3, { at: new Date('2026-06-01T00:00:00.000Z') }),
        ).rejects.toMatchObject({ code: 'REFERRAL_RULE_AMBIGUOUS' });
      } finally {
        client3.release();
      }
    } finally {
      await pool.query(`DELETE FROM referral_rule_versions`);
      await pool.query(`
        ALTER TABLE referral_rule_versions
          ADD CONSTRAINT referral_rule_versions_no_active_overlap
            EXCLUDE USING gist (
              tstzrange(effective_from, effective_to, '[)') WITH &&
            ) WHERE (status = 'ACTIVE')
      `);
    }
  });

  it('loads by number and evaluation-time FOR SHARE resolver uses server now', async () => {
    await pool.query(`DELETE FROM referral_rule_versions`);
    await insertReferralRule(pool, {
      ruleVersion: 801,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      baseRateBps: TEST_REFERRAL_BASE_RATE_BPS,
    });
    const client = await pool.connect();
    try {
      const loaded = await loadReferralRuleVersionByNumber(client, 801);
      expect(loaded.baseRateBps).toBe(TEST_REFERRAL_BASE_RATE_BPS);
      const evalResolved = await resolveActiveReferralRuleVersionForEvaluation(client);
      expect(evalResolved.ruleVersion).toBe(801);
    } finally {
      client.release();
    }
  });
});

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 referral referenced immutability', () => {
  let pool: Pool;
  let referrerId: string;
  let referredId: string;
  let codeId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
    referrerId = await createTestUser(pool, '15000001');
    referredId = await createTestUser(pool, '15000002');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: 'P15CODE1' });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  async function activateEdgeReferencing(ruleVersion: number): Promise<{
    readonly edgeId: string;
    readonly activatedAt: Date;
  }> {
    await insertReferralRule(pool, {
      ruleVersion,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    // Fresh referred user per activation (unique referred_user_id).
    const referred = await createTestUser(
      pool,
      String(15_100_000 + ruleVersion),
    );
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });
    const activatedAt = new Date('2026-03-01T12:00:00.000Z');
    await pool.query(
      `UPDATE referral_edges
       SET state = 'ACTIVE'::referral_edge_state,
           activated_at = $2::timestamptz,
           activation_rule_version = $3
       WHERE id = $1::uuid`,
      [edgeId, activatedAt.toISOString(), ruleVersion],
    );
    return { edgeId, activatedAt };
  }

  it('rejects referenced economics/provenance updates; allows status + safe effective_to', async () => {
    const ruleVersion = 1010;
    const { activatedAt } = await activateEdgeReferencing(ruleVersion);

    await expect(
      pool.query(`UPDATE referral_rule_versions SET base_rate_bps = 1 WHERE rule_version = $1`, [
        ruleVersion,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE referral_rule_versions
         SET effective_from = '2019-01-01T00:00:00.000Z'::timestamptz
         WHERE rule_version = $1`,
        [ruleVersion],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_rule_versions
         SET status = 'SUPERSEDED'::rule_version_status
         WHERE rule_version = $1`,
        [ruleVersion],
      ),
    ).resolves.toBeTruthy();

    const closure = new Date(activatedAt.getTime() + 60_000);
    await expect(
      pool.query(
        `UPDATE referral_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
        [ruleVersion, closure.toISOString()],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `UPDATE referral_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
        [ruleVersion, new Date(closure.getTime() + 60_000).toISOString()],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    const ruleVersion2 = 1011;
    const second = await activateEdgeReferencing(ruleVersion2);
    await expect(
      pool.query(
        `UPDATE referral_rule_versions SET effective_to = $2::timestamptz WHERE rule_version = $1`,
        [ruleVersion2, second.activatedAt.toISOString()],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('allows freer effective_to on unreferenced rules', async () => {
    await insertReferralRule(pool, {
      ruleVersion: 1016,
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    await pool.query(
      `UPDATE referral_rule_versions
       SET effective_to = '2026-07-01T00:00:00.000Z'::timestamptz
       WHERE rule_version = 1016`,
    );
    await pool.query(
      `UPDATE referral_rule_versions
       SET effective_to = '2026-08-01T00:00:00.000Z'::timestamptz
       WHERE rule_version = 1016`,
    );
    await pool.query(
      `UPDATE referral_rule_versions SET effective_to = NULL WHERE rule_version = 1016`,
    );
  });
});

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 referral first-reference concurrency', () => {
  let pool: Pool;
  let referrerId: string;
  let codeId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
    referrerId = await createTestUser(pool, '15001001');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: 'P15LOCK1' });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('edge activation FOR SHARE blocks concurrent semantic UPDATE', async () => {
    await insertReferralRule(pool, {
      ruleVersion: 1020,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      baseRateBps: TEST_REFERRAL_BASE_RATE_BPS,
    });
    const referred = await createTestUser(pool, '15001002');
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });
    const original = await pool.query<{ base_rate_bps: number }>(
      `SELECT base_rate_bps FROM referral_rule_versions WHERE rule_version = 1020`,
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const watcher = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientA.query(
        `UPDATE referral_edges
         SET state = 'ACTIVE'::referral_edge_state,
             activated_at = now(),
             activation_rule_version = 1020
         WHERE id = $1::uuid`,
        [edgeId],
      );
      const holderPid = (
        await clientA.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const updatePromise = clientB.query(
        `UPDATE referral_rule_versions SET base_rate_bps = 999 WHERE rule_version = 1020`,
      );
      expect(await waitForBlockedOnHolder(watcher, holderPid)).toBe(true);
      await clientA.query('COMMIT');
      await expect(updatePromise).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

      const after = await pool.query<{ base_rate_bps: number }>(
        `SELECT base_rate_bps FROM referral_rule_versions WHERE rule_version = 1020`,
      );
      expect(after.rows[0]?.base_rate_bps).toBe(original.rows[0]?.base_rate_bps);
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
});

describe.skipIf(phase15DatabaseUrl === '')('Phase 15 referral edges / codes / events', () => {
  let pool: Pool;
  let referrerId: string;
  let codeId: string;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase15DatabaseUrl);
    pool = createPool(phase15DatabaseUrl);
    referrerId = await createTestUser(pool, '15002001');
    codeId = await insertReferralCode(pool, { userId: referrerId, code: 'P15EDGE1' });
    const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
    assetId = asset.rows[0]!.id;
    await insertReferralRule(pool, {
      ruleVersion: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('freezes edge attribution and enforces state machine + field consistency', async () => {
    const referred = await createTestUser(pool, '15002002');
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });

    await expect(
      pool.query(`UPDATE referral_edges SET referrer_user_id = $1::uuid WHERE id = $2::uuid`, [
        referred,
        edgeId,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET state = 'ACTIVE'::referral_edge_state,
             activated_at = now()
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await pool.query(
      `UPDATE referral_edges
       SET state = 'ACTIVE'::referral_edge_state,
           activated_at = now(),
           activation_rule_version = 1
       WHERE id = $1::uuid`,
      [edgeId],
    );

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET state = 'REJECTED'::referral_edge_state,
             activated_at = NULL,
             rejected_at = now(),
             rejection_reason = 'nope',
             activation_rule_version = NULL
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    const referred2 = await createTestUser(pool, '15002003');
    const pending2 = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred2,
      codeId,
    });
    await pool.query(
      `UPDATE referral_edges
       SET state = 'REJECTED'::referral_edge_state,
           rejected_at = now(),
           rejection_reason = 'fraud'
       WHERE id = $1::uuid`,
      [pending2],
    );
    await expect(
      pool.query(
        `UPDATE referral_edges
         SET rejection_reason = 'changed'
         WHERE id = $1::uuid`,
        [pending2],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('freezes ACTIVE terminal activation provenance', async () => {
    await insertReferralRule(pool, {
      ruleVersion: 2,
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    });
    const referred = await createTestUser(pool, '15002005');
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });

    const activated = await pool.query<{
      activation_rule_version: number;
      activated_at: Date;
      rejected_at: Date | null;
      rejection_reason: string | null;
      state: string;
    }>(
      `UPDATE referral_edges
       SET state = 'ACTIVE'::referral_edge_state,
           activated_at = timestamptz '2024-06-01T12:00:00.000Z',
           activation_rule_version = 1
       WHERE id = $1::uuid
       RETURNING activation_rule_version, activated_at, rejected_at, rejection_reason, state::text AS state`,
      [edgeId],
    );
    const original = activated.rows[0]!;
    expect(original.state).toBe('ACTIVE');
    expect(original.activation_rule_version).toBe(1);

    await expect(
      pool.query(
        `UPDATE referral_edges SET activation_rule_version = 2 WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET activated_at = timestamptz '2025-01-01T00:00:00.000Z'
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET rejected_at = now(), rejection_reason = 'nope'
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET state = 'ACTIVE'::referral_edge_state,
             activation_rule_version = 2,
             activated_at = now()
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET state = 'PENDING'::referral_edge_state,
             activated_at = NULL,
             activation_rule_version = NULL
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    const after = await pool.query<{
      activation_rule_version: number;
      activated_at: Date;
      rejected_at: Date | null;
      rejection_reason: string | null;
      state: string;
    }>(
      `SELECT activation_rule_version, activated_at, rejected_at, rejection_reason,
              state::text AS state
       FROM referral_edges WHERE id = $1::uuid`,
      [edgeId],
    );
    expect(after.rows[0]).toMatchObject({
      state: 'ACTIVE',
      activation_rule_version: 1,
      rejected_at: null,
      rejection_reason: null,
    });
    expect(after.rows[0]!.activated_at.toISOString()).toBe(
      original.activated_at.toISOString(),
    );
  });

  it('freezes REJECTED terminal rejection provenance', async () => {
    const referred = await createTestUser(pool, '15002006');
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });

    const rejected = await pool.query<{
      activation_rule_version: number | null;
      activated_at: Date | null;
      rejected_at: Date;
      rejection_reason: string;
      state: string;
    }>(
      `UPDATE referral_edges
       SET state = 'REJECTED'::referral_edge_state,
           rejected_at = timestamptz '2024-07-01T08:00:00.000Z',
           rejection_reason = 'critical_fraud',
           activation_rule_version = 1
       WHERE id = $1::uuid
       RETURNING activation_rule_version, activated_at, rejected_at, rejection_reason,
                 state::text AS state`,
      [edgeId],
    );
    const original = rejected.rows[0]!;
    expect(original.state).toBe('REJECTED');
    expect(original.rejection_reason).toBe('critical_fraud');
    expect(original.activation_rule_version).toBe(1);

    await expect(
      pool.query(
        `UPDATE referral_edges SET rejection_reason = 'other' WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET rejected_at = timestamptz '2025-01-01T00:00:00.000Z'
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges SET activation_rule_version = 2 WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges
         SET state = 'REJECTED'::referral_edge_state,
             rejection_reason = 'rewrite'
         WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(
        `UPDATE referral_edges SET state = 'ACTIVE'::referral_edge_state WHERE id = $1::uuid`,
        [edgeId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    const after = await pool.query<{
      activation_rule_version: number | null;
      activated_at: Date | null;
      rejected_at: Date;
      rejection_reason: string;
      state: string;
    }>(
      `SELECT activation_rule_version, activated_at, rejected_at, rejection_reason,
              state::text AS state
       FROM referral_edges WHERE id = $1::uuid`,
      [edgeId],
    );
    expect(after.rows[0]).toMatchObject({
      state: 'REJECTED',
      rejection_reason: 'critical_fraud',
      activation_rule_version: 1,
      activated_at: null,
    });
    expect(after.rows[0]!.rejected_at.toISOString()).toBe(original.rejected_at.toISOString());
  });

  it('validates referral rule FKs (convalidated=true)', async () => {
    const rows = await pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
       FROM pg_constraint
       WHERE conname IN (
         'referral_edges_activation_rule_version_fkey',
         'referral_reward_events_rule_version_fkey'
       )
       ORDER BY conname`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.convalidated === true)).toBe(true);
  });

  it('freezes referral code identity but allows status', async () => {
    await expect(
      pool.query(`UPDATE referral_codes SET code = 'HACKED' WHERE id = $1::uuid`, [codeId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE referral_codes SET status = 'DISABLED'::activation_status WHERE id = $1::uuid`,
        [codeId],
      ),
    ).resolves.toBeTruthy();
  });

  it('keeps referral_reward_events append-only and FK-bound', async () => {
    const referred = await createTestUser(pool, '15002004');
    const edgeId = await insertPendingEdge(pool, {
      referrerUserId: referrerId,
      referredUserId: referred,
      codeId,
    });
    await pool.query(
      `UPDATE referral_edges
       SET state = 'ACTIVE'::referral_edge_state,
           activated_at = now(),
           activation_rule_version = 1
       WHERE id = $1::uuid`,
      [edgeId],
    );

    const rewardEvent = await pool.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state
       ) VALUES (
         $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, 100, 'AVAILABLE'::reward_event_state
       )
       RETURNING id`,
      [referrerId, edgeId, assetId],
    );

    await expect(
      pool.query(
        `INSERT INTO referral_reward_events (
           referral_edge_id, referrer_user_id, source_reward_event_id,
           rate_bps, rule_version, amount_atomic, rate_source
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 123, 99999, 10, 'BASE_RULE'::referral_rate_source
         )`,
        [edgeId, referrerId, rewardEvent.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION });

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO referral_reward_events (
         referral_edge_id, referrer_user_id, source_reward_event_id,
         rate_bps, rule_version, amount_atomic, rate_source
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 123, 1, 10, 'BASE_RULE'::referral_rate_source
       )
       RETURNING id`,
      [edgeId, referrerId, rewardEvent.rows[0]!.id],
    );
    const eventId = inserted.rows[0]!.id;

    await expect(
      pool.query(`UPDATE referral_reward_events SET amount_atomic = 99 WHERE id = $1::uuid`, [
        eventId,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(`DELETE FROM referral_reward_events WHERE id = $1::uuid`, [eventId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });
});
