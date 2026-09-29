import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  MissionDomainError,
  getMissionVersionById,
  resolveActiveMissionVersion,
  resolveActiveMissionVersionForEvaluation,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertMissionDefinition,
  insertMissionProgress,
  insertMissionVersion,
  phase16DatabaseUrl,
  resetAndMigrate,
  waitForBlockedOnHolder,
} from './harness.js';

const EXCLUSION_VIOLATION = '23P01';
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

describe.skipIf(phase16DatabaseUrl === '')('Phase 16 mission integrity + resolver (DB)', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = createPool(phase16DatabaseUrl);
    userId = await createTestUser(pool, '16000001');
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  async function freshDefinition(code: string): Promise<string> {
    return insertMissionDefinition(pool, { code, status: 'ACTIVE' });
  }

  it('rejects overlapping ACTIVE windows for the same definition', async () => {
    const defId = await freshDefinition('P16_OVERLAP');
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: defId,
        missionVersion: 2,
        status: 'ACTIVE',
        startAt: new Date('2026-05-01T00:00:00.000Z'),
        endAt: new Date('2026-12-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: EXCLUSION_VIOLATION });
  });

  it('allows adjacent ACTIVE windows and overlapping DRAFT', async () => {
    const defId = await freshDefinition('P16_ADJACENT');
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: defId,
        missionVersion: 2,
        status: 'ACTIVE',
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    const draftDef = await freshDefinition('P16_DRAFT_OVERLAP');
    await insertMissionVersion(pool, {
      missionDefinitionId: draftDef,
      missionVersion: 1,
      status: 'DRAFT',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: draftDef,
        missionVersion: 2,
        status: 'DRAFT',
        startAt: new Date('2026-03-01T00:00:00.000Z'),
        endAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('freezes definition identity; allows status; blocks delete when versions exist', async () => {
    const defId = await freshDefinition('P16_DEF_FREEZE');
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'DRAFT',
      startAt: null,
      endAt: null,
    });

    await expect(
      pool.query(`UPDATE mission_definitions SET code = 'CHANGED' WHERE id = $1::uuid`, [defId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(`UPDATE mission_definitions SET name_key = 'x' WHERE id = $1::uuid`, [defId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE mission_definitions SET status = 'PAUSED'::content_status WHERE id = $1::uuid`,
        [defId],
      ),
    ).resolves.toBeTruthy();
    await expect(
      pool.query(`DELETE FROM mission_definitions WHERE id = $1::uuid`, [defId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('freezes mission version semantics; allows status + safe end_at closure', async () => {
    const defId = await freshDefinition('P16_SEM_FREEZE');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'DRAFT',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
    });

    await expect(
      pool.query(`UPDATE mission_versions SET target = 9 WHERE id = $1::uuid`, [versionId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(`UPDATE mission_versions SET name_key = 'changed' WHERE id = $1::uuid`, [
        versionId,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(
        `UPDATE mission_versions SET status = 'ACTIVE'::rule_version_status WHERE id = $1::uuid`,
        [versionId],
      ),
    ).resolves.toBeTruthy();

    // Unreferenced first NULL→non-null end_at OK.
    await expect(
      pool.query(
        `UPDATE mission_versions
         SET end_at = '2026-12-01T00:00:00.000Z'::timestamptz
         WHERE id = $1::uuid`,
        [versionId],
      ),
    ).resolves.toBeTruthy();

    // Non-null rewrite rejected.
    await expect(
      pool.query(
        `UPDATE mission_versions
         SET end_at = '2027-01-01T00:00:00.000Z'::timestamptz
         WHERE id = $1::uuid`,
        [versionId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    // Reopen rejected.
    await expect(
      pool.query(`UPDATE mission_versions SET end_at = NULL WHERE id = $1::uuid`, [versionId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('rejects referenced end_at closure at or before latest progress/claim ref', async () => {
    const defId = await freshDefinition('P16_END_REF');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
    });
    const startedAt = new Date(Date.now() - 60_000);
    const completedAt = new Date(Date.now() - 30_000);
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 1,
      state: 'COMPLETED',
      progressCount: 1,
      startedAt,
      completedAt,
    });
    expect(progressId).toMatch(/^[0-9a-f-]{36}$/i);

    const maxRef = await pool.query<{ max_ref: Date }>(
      `SELECT GREATEST(
         (SELECT MAX(p.created_at) FROM mission_progress p WHERE p.mission_version_id = $1::uuid),
         (SELECT MAX(p.started_at) FROM mission_progress p WHERE p.mission_version_id = $1::uuid),
         (SELECT MAX(p.completed_at) FROM mission_progress p WHERE p.mission_version_id = $1::uuid),
         (SELECT MAX(c.claimed_at) FROM mission_claims c WHERE c.mission_version_id = $1::uuid),
         (SELECT MAX(c.granted_at) FROM mission_claims c WHERE c.mission_version_id = $1::uuid)
       ) AS max_ref`,
      [versionId],
    );
    const ref = maxRef.rows[0]?.max_ref;
    if (ref === undefined) throw new Error('expected progress reference timestamp');

    await expect(
      pool.query(
        `UPDATE mission_versions SET end_at = $2::timestamptz WHERE id = $1::uuid`,
        [versionId, ref.toISOString()],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    const afterRef = new Date(ref.getTime() + 1000);
    await expect(
      pool.query(
        `UPDATE mission_versions SET end_at = $2::timestamptz WHERE id = $1::uuid`,
        [versionId, afterRef.toISOString()],
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects end_at <= start_at on closure', async () => {
    const defId = await freshDefinition('P16_END_WINDOW');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'DRAFT',
      startAt: new Date('2026-06-01T00:00:00.000Z'),
      endAt: null,
    });
    await expect(
      pool.query(
        `UPDATE mission_versions
         SET end_at = '2026-06-01T00:00:00.000Z'::timestamptz
         WHERE id = $1::uuid`,
        [versionId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('requires progress target to match version; rejects CLAIMED and identity mutation', async () => {
    const defId = await freshDefinition('P16_PROG_TARGET');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 5,
    });

    await expect(
      insertMissionProgress(pool, {
        missionVersionId: versionId,
        userId,
        target: 4,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 5,
    });

    await expect(
      pool.query(
        `UPDATE mission_progress SET state = 'CLAIMED'::task_progress_state WHERE id = $1::uuid`,
        [progressId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await expect(
      pool.query(`UPDATE mission_progress SET period_key = 'OTHER' WHERE id = $1::uuid`, [
        progressId,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('enforces progress state machine, field consistency, and monotonic count', async () => {
    const defId = await freshDefinition('P16_PROG_SM');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
    });
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 3,
    });

    await expect(
      pool.query(
        `UPDATE mission_progress
         SET state = 'IN_PROGRESS'::task_progress_state,
             progress_count = 1,
             started_at = '2026-02-01T00:00:00.000Z'::timestamptz
         WHERE id = $1::uuid`,
        [progressId],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `UPDATE mission_progress SET progress_count = 0 WHERE id = $1::uuid`,
        [progressId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await expect(
      pool.query(
        `UPDATE mission_progress
         SET state = 'COMPLETED'::task_progress_state,
             progress_count = 3,
             completed_at = '2026-02-02T00:00:00.000Z'::timestamptz
         WHERE id = $1::uuid`,
        [progressId],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `UPDATE mission_progress
         SET state = 'EXPIRED'::task_progress_state,
             completed_at = NULL
         WHERE id = $1::uuid`,
        [progressId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('mission_progress_events are append-only with unique source and parent match', async () => {
    const defId = await freshDefinition('P16_PROG_EVT');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 2,
    });
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 2,
    });

    const eventId = (
      await pool.query<{ id: string }>(
        `INSERT INTO mission_progress_events (
           mission_progress_id, mission_version_id, user_id, period_key,
           source_kind, source_key, progress_delta, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME',
           'AUTHENTICATED_LOGIN_DAY', '2026-02-01', 1,
           '2026-02-01T12:00:00.000Z'::timestamptz
         ) RETURNING id`,
        [progressId, versionId, userId],
      )
    ).rows[0]!.id;

    await expect(
      pool.query(
        `INSERT INTO mission_progress_events (
           mission_progress_id, mission_version_id, user_id, period_key,
           source_kind, source_key, progress_delta, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME',
           'AUTHENTICATED_LOGIN_DAY', '2026-02-01', 1,
           '2026-02-01T12:00:00.000Z'::timestamptz
         )`,
        [progressId, versionId, userId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // Same source_key on a different progress row is allowed.
    const otherUserForEvent = await createTestUser(pool, '16000098');
    const otherProgress = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId: otherUserForEvent,
      periodKey: 'LIFETIME',
      target: 2,
    });
    await expect(
      pool.query(
        `INSERT INTO mission_progress_events (
           mission_progress_id, mission_version_id, user_id, period_key,
           source_kind, source_key, progress_delta, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME',
           'AUTHENTICATED_LOGIN_DAY', '2026-02-01', 1,
           '2026-02-01T12:00:00.000Z'::timestamptz
         )`,
        [otherProgress, versionId, otherUserForEvent],
      ),
    ).resolves.toBeTruthy();

    await expect(
      pool.query(
        `INSERT INTO mission_progress_events (
           mission_progress_id, mission_version_id, user_id, period_key,
           source_kind, source_key, progress_delta, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME',
           'STREAK_DAY', 'day-1', 0,
           now()
         )`,
        [progressId, versionId, userId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const otherUser = await createTestUser(pool, '16000099');
    await expect(
      pool.query(
        `INSERT INTO mission_progress_events (
           mission_progress_id, mission_version_id, user_id, period_key,
           source_kind, source_key, progress_delta, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME',
           'STREAK_DAY', 'day-1', 1,
           now()
         )`,
        [progressId, versionId, otherUser],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION });

    await expect(
      pool.query(
        `UPDATE mission_progress_events SET progress_delta = 2 WHERE id = $1::uuid`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(`DELETE FROM mission_progress_events WHERE id = $1::uuid`, [eventId]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('mission_claims require matching progress; state machine + claim events', async () => {
    const defId = await freshDefinition('P16_CLAIM');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
    });
    const progressId = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId,
      target: 1,
      state: 'COMPLETED',
      progressCount: 1,
      startedAt: new Date('2026-02-01T00:00:00.000Z'),
      completedAt: new Date('2026-02-01T01:00:00.000Z'),
    });

    const claimId = (
      await pool.query<{ id: string }>(
        `INSERT INTO mission_claims (
           mission_version_id, mission_progress_id, user_id, period_key, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME', 'PENDING'::mission_claim_status
         ) RETURNING id`,
        [versionId, progressId, userId],
      )
    ).rows[0]!.id;

    const events = await pool.query<{ to_status: string; from_status: string | null }>(
      `SELECT from_status::text AS from_status, to_status::text AS to_status
       FROM mission_claim_events WHERE mission_claim_id = $1::uuid`,
      [claimId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ from_status: null, to_status: 'PENDING' });

    await expect(
      pool.query(
        `UPDATE mission_claims
         SET status = 'REJECTED'::mission_claim_status,
             rejection_reason = 'not eligible'
         WHERE id = $1::uuid`,
        [claimId],
      ),
    ).resolves.toBeTruthy();

    const after = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claim_events WHERE mission_claim_id = $1::uuid`,
      [claimId],
    );
    expect(after.rows[0]?.c).toBe(2);

    await expect(
      pool.query(
        `UPDATE mission_claims
         SET status = 'PENDING'::mission_claim_status, rejection_reason = NULL
         WHERE id = $1::uuid`,
        [claimId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    await expect(
      pool.query(`UPDATE mission_claim_events SET to_status = 'GRANTED' WHERE mission_claim_id = $1::uuid`, [
        claimId,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    // Separate claim: PENDING → GRANTED with NULL reward_event_id (non-monetary capability).
    const grantProgress = await insertMissionProgress(pool, {
      missionVersionId: versionId,
      userId: await createTestUser(pool, '16000101'),
      periodKey: 'LIFETIME-G',
      target: 1,
      state: 'COMPLETED',
      progressCount: 1,
      startedAt: new Date('2026-02-01T00:00:00.000Z'),
      completedAt: new Date('2026-02-01T01:00:00.000Z'),
    });
    const grantUser = (
      await pool.query<{ user_id: string }>(
        `SELECT user_id FROM mission_progress WHERE id = $1::uuid`,
        [grantProgress],
      )
    ).rows[0]!.user_id;
    const grantClaimId = (
      await pool.query<{ id: string }>(
        `INSERT INTO mission_claims (
           mission_version_id, mission_progress_id, user_id, period_key, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LIFETIME-G', 'PENDING'::mission_claim_status
         ) RETURNING id`,
        [versionId, grantProgress, grantUser],
      )
    ).rows[0]!.id;
    await expect(
      pool.query(
        `UPDATE mission_claims
         SET status = 'GRANTED'::mission_claim_status,
             granted_at = now(),
             reward_event_id = NULL
         WHERE id = $1::uuid`,
        [grantClaimId],
      ),
    ).resolves.toBeTruthy();
    const grantEvents = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_claim_events WHERE mission_claim_id = $1::uuid`,
      [grantClaimId],
    );
    expect(grantEvents.rows[0]?.c).toBe(2);
    await expect(
      pool.query(
        `UPDATE mission_claims
         SET status = 'REJECTED'::mission_claim_status,
             rejection_reason = 'too late',
             granted_at = NULL
         WHERE id = $1::uuid`,
        [grantClaimId],
      ),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('composite reward_rule FK requires matching source_type; NULL reward_rule_id allowed', async () => {
    const defId = await freshDefinition('P16_REWARD_FK');
    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: defId,
        missionVersion: 1,
        status: 'DRAFT',
        startAt: null,
        endAt: null,
        rewardRuleId: null,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
    const assetId = asset.rows[0]?.id;
    if (assetId === undefined) throw new Error('USDT missing');

    const adRule = await pool.query<{ id: string }>(
      `INSERT INTO reward_rules (
         code, rule_version, source_type, asset_id, fixed_reward_atomic, status
       ) VALUES (
         'p16-ad-rule', 1, 'AD'::reward_source_type, $1::uuid, 100, 'DRAFT'::rule_version_status
       ) RETURNING id`,
      [assetId],
    );
    const adRuleId = adRule.rows[0]!.id;

    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: defId,
        missionVersion: 2,
        status: 'DRAFT',
        startAt: null,
        endAt: null,
        rewardSourceType: 'MISSION',
        rewardRuleId: adRuleId,
      }),
    ).rejects.toMatchObject({ code: FK_VIOLATION });

    const missionRule = await pool.query<{ id: string }>(
      `INSERT INTO reward_rules (
         code, rule_version, source_type, asset_id, fixed_reward_atomic, status
       ) VALUES (
         'p16-mission-rule', 1, 'MISSION'::reward_source_type, $1::uuid, 100,
         'DRAFT'::rule_version_status
       ) RETURNING id`,
      [assetId],
    );
    await expect(
      insertMissionVersion(pool, {
        missionDefinitionId: defId,
        missionVersion: 3,
        status: 'DRAFT',
        startAt: null,
        endAt: null,
        rewardSourceType: 'MISSION',
        rewardRuleId: missionRule.rows[0]!.id,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('task_reward_events reject UPDATE and DELETE', async () => {
    const taskDef = await pool.query<{ id: string }>(
      `INSERT INTO task_definitions (code, name_key, status)
       VALUES ('p16-legacy-task', 't.legacy', 'DRAFT'::content_status)
       RETURNING id`,
    );
    const taskVersion = await pool.query<{ id: string }>(
      `INSERT INTO task_definition_versions (
         task_definition_id, task_version, condition_type, target, status
       ) VALUES (
         $1::uuid, 1, 'DAILY_LOGIN'::mission_condition_type, 1, 'DRAFT'::rule_version_status
       ) RETURNING id`,
      [taskDef.rows[0]!.id],
    );
    const progress = await pool.query<{ id: string }>(
      `INSERT INTO user_task_progress (
         user_id, task_definition_version_id, period_key, progress_count, target, state
       ) VALUES (
         $1::uuid, $2::uuid, 'LIFETIME', 0, 1, 'NOT_STARTED'::task_progress_state
       ) RETURNING id`,
      [userId, taskVersion.rows[0]!.id],
    );
    const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
    const reward = await pool.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state
       ) VALUES (
         $1::uuid, 'TASK'::reward_source_type, $2::uuid, $3::uuid, 1,
         'CREATED'::reward_event_state
       ) RETURNING id`,
      [userId, progress.rows[0]!.id, asset.rows[0]!.id],
    );
    const bridge = await pool.query<{ id: string }>(
      `INSERT INTO task_reward_events (user_task_progress_id, reward_event_id)
       VALUES ($1::uuid, $2::uuid)
       RETURNING id`,
      [progress.rows[0]!.id, reward.rows[0]!.id],
    );
    await expect(
      pool.query(`UPDATE task_reward_events SET reward_event_id = reward_event_id WHERE id = $1::uuid`, [
        bridge.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      pool.query(`DELETE FROM task_reward_events WHERE id = $1::uuid`, [bridge.rows[0]!.id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('resolves one ACTIVE version and fails closed on zero / ambiguous', async () => {
    const defId = await freshDefinition('P16_RESOLVE');
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2025-01-01T00:00:00.000Z'),
      endAt: new Date('2026-01-01T00:00:00.000Z'),
      target: 1,
    });
    const v2 = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 2,
      status: 'ACTIVE',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: new Date('2027-01-01T00:00:00.000Z'),
      target: 2,
    });

    const client = await pool.connect();
    try {
      const resolved = await resolveActiveMissionVersion(client, {
        missionDefinitionId: defId,
        at: new Date('2026-06-15T12:00:00.000Z'),
      });
      expect(resolved.id).toBe(v2);
      expect(resolved.target).toBe(2);

      await expect(
        resolveActiveMissionVersion(client, {
          missionDefinitionId: defId,
          at: new Date('2024-01-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'MISSION_NOT_CONFIGURED' });

      const byId = await getMissionVersionById(client, v2);
      expect(byId.missionVersion).toBe(2);

      await expect(
        getMissionVersionById(client, '00000000-0000-4000-8000-000000000099'),
      ).rejects.toMatchObject({ code: 'MISSION_VERSION_NOT_FOUND' });
    } finally {
      client.release();
    }

    // Ambiguous path: temporarily drop exclusion and insert overlapping ACTIVE.
    await pool.query(
      `ALTER TABLE mission_versions DROP CONSTRAINT mission_versions_no_active_overlap`,
    );
    try {
      const ambDef = await freshDefinition('P16_AMBIG');
      await insertMissionVersion(pool, {
        missionDefinitionId: ambDef,
        missionVersion: 1,
        status: 'ACTIVE',
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: null,
      });
      await insertMissionVersion(pool, {
        missionDefinitionId: ambDef,
        missionVersion: 2,
        status: 'ACTIVE',
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: null,
      });
      const client2 = await pool.connect();
      try {
        await expect(
          resolveActiveMissionVersion(client2, {
            missionDefinitionId: ambDef,
            at: new Date('2026-06-01T00:00:00.000Z'),
          }),
        ).rejects.toMatchObject({ code: 'MISSION_VERSION_AMBIGUOUS' });
        await expect(
          resolveActiveMissionVersion(client2, { code: 'P16_AMBIG' }),
        ).rejects.toBeInstanceOf(MissionDomainError);
      } finally {
        client2.release();
      }
    } finally {
      await pool.query(
        `DELETE FROM mission_versions
         WHERE mission_definition_id IN (
           SELECT id FROM mission_definitions WHERE code = 'P16_AMBIG'
         )`,
      );
      await pool.query(`
        ALTER TABLE mission_versions
          ADD CONSTRAINT mission_versions_no_active_overlap
            EXCLUDE USING gist (
              mission_definition_id WITH =,
              tstzrange(start_at, end_at, '[)') WITH &&
            ) WHERE (status = 'ACTIVE')
      `);
    }
  });

  it('first-reference FOR SHARE: progress INSERT blocks concurrent end_at closure', async () => {
    const defId = await freshDefinition('P16_REF_A');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
    });

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO mission_progress (
           mission_version_id, user_id, period_key, progress_count, target, state
         ) VALUES (
           $1::uuid, $2::uuid, 'LIFETIME', 0, 1, 'NOT_STARTED'::task_progress_state
         )`,
        [versionId, userId],
      );

      const holderPid = (
        await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      let waiterError: unknown;
      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        try {
          await waiter.query(
            `UPDATE mission_versions
             SET end_at = '2020-06-01T00:00:00.000Z'::timestamptz
             WHERE id = $1::uuid`,
            [versionId],
          );
          await waiter.query('COMMIT');
        } catch (error) {
          waiterError = error;
          try {
            await waiter.query('ROLLBACK');
          } catch {
            // ignore
          }
        }
      })();

      const blocked = await waitForBlockedOnHolder(watcher, holderPid, 8_000);
      expect(blocked).toBe(true);

      await holder.query('COMMIT');
      await waitPromise;

      // Retroactive closure at/before the held progress created_at must reject.
      expect(waiterError).toMatchObject({ code: RESTRICT_VIOLATION });
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('first-reference FOR SHARE: lifecycle UPDATE blocks concurrent progress INSERT', async () => {
    const defId = await freshDefinition('P16_REF_B');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
    });
    const refUser = await createTestUser(pool, '16000202');

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      // Allowed lifecycle update (status) held open — takes ROW EXCLUSIVE.
      await holder.query(
        `UPDATE mission_versions
         SET status = 'ACTIVE'::rule_version_status
         WHERE id = $1::uuid`,
        [versionId],
      );

      const holderPid = (
        await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `INSERT INTO mission_progress (
             mission_version_id, user_id, period_key, progress_count, target, state
           ) VALUES (
             $1::uuid, $2::uuid, 'LIFETIME', 0, 1, 'NOT_STARTED'::task_progress_state
           )`,
          [versionId, refUser],
        );
        await waiter.query('COMMIT');
      })();

      const blocked = await waitForBlockedOnHolder(watcher, holderPid, 8_000);
      expect(blocked).toBe(true);

      await holder.query('COMMIT');
      await waitPromise;

      const inserted = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM mission_progress
         WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
        [versionId, refUser],
      );
      expect(inserted.rows[0]?.c).toBe(1);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });

  it('evaluation FOR SHARE blocks concurrent writers on the version row', async () => {
    const defId = await freshDefinition('P16_FOR_SHARE');
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
    });

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      const resolved = await resolveActiveMissionVersionForEvaluation(holder, {
        missionDefinitionId: defId,
      });
      expect(resolved.id).toBe(versionId);

      const holderPid = (
        await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;

      const waitPromise = (async () => {
        await waiter.query('BEGIN');
        await waiter.query(
          `UPDATE mission_versions
           SET status = 'SUPERSEDED'::rule_version_status
           WHERE id = $1::uuid`,
          [versionId],
        );
        await waiter.query('COMMIT');
      })();

      const blocked = await waitForBlockedOnHolder(watcher, holderPid, 8_000);
      expect(blocked).toBe(true);

      await holder.query('COMMIT');
      await waitPromise;
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  });
});
