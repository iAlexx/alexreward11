import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  MissionDomainError,
  contributeMissionProgress,
  resolveMissionPeriod,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertMissionDefinition,
  insertMissionVersion,
  phase16DatabaseUrl,
  resetAndMigrate,
  waitForBlockedOnHolder,
} from './harness.js';

describe.skipIf(phase16DatabaseUrl === '')('Phase 16 Step 2 progress contribution (DB)', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = createPool(phase16DatabaseUrl);
    userId = await createTestUser(pool, '16200001');
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  async function activeDailyLogin(code: string, target = 1) {
    const defId = await insertMissionDefinition(pool, { code, status: 'ACTIVE' });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'DAILY',
    });
    return { defId, versionId };
  }

  it('contributes DAILY_LOGIN once per UTC day; replay is ALREADY_CONTRIBUTED', async () => {
    const { versionId } = await activeDailyLogin('P16S2_LOGIN');
    const occurredAt = new Date('2026-04-10T15:00:00.000Z');
    const period = resolveMissionPeriod('DAILY', occurredAt);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: period.periodKey,
        occurredAt,
      });
      expect(first.outcome).toBe('CONTRIBUTED');
      if (first.outcome === 'CONTRIBUTED') {
        expect(first.state).toBe('COMPLETED');
        expect(first.progressCount).toBe(1);
        expect(first.periodKey).toBe('DAY:2026-04-10');
        expect(first.completed).toBe(true);
      }

      const replay = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'AUTHENTICATED_LOGIN_DAY',
        sourceKey: period.periodKey,
        occurredAt,
      });
      expect(replay.outcome).toBe('ALREADY_CONTRIBUTED');

      const outbox = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM outbox_events
         WHERE event_type = 'mission.completed'
           AND dedupe_key = $1`,
        [`mission-completed/${first.outcome === 'CONTRIBUTED' ? first.progressId : ''}`],
      );
      expect(outbox.rows[0]?.c).toBe(1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('rejects wrong source kind and client-supplied period authority is unused', async () => {
    const { versionId } = await activeDailyLogin('P16S2_SRC');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        contributeMissionProgress(client, {
          missionVersionId: versionId,
          userId,
          sourceKind: 'REWARD_EVENT',
          sourceKey: 'ad-1',
          occurredAt: new Date('2026-04-11T12:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'MISSION_SOURCE_MISMATCH' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('VALID_AD_COUNT advances to COMPLETED at target with outbox once', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: 'P16S2_ADS3',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let progressId = '';
      for (let i = 1; i <= 3; i += 1) {
        const result = await contributeMissionProgress(client, {
          missionVersionId: versionId,
          userId,
          sourceKind: 'REWARD_EVENT',
          sourceKey: `reward-${i}`,
          occurredAt: new Date(`2026-05-01T0${i}:00:00.000Z`),
        });
        expect(result.outcome).toBe('CONTRIBUTED');
        if (result.outcome === 'CONTRIBUTED') {
          progressId = result.progressId;
          expect(result.progressCount).toBe(i);
          expect(result.completed).toBe(i === 3);
        }
      }
      const fourth = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'REWARD_EVENT',
        sourceKey: 'reward-4',
        occurredAt: new Date('2026-05-01T04:00:00.000Z'),
      });
      expect(fourth.outcome).toBe('IGNORED_TERMINAL');

      const outbox = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM outbox_events
         WHERE dedupe_key = $1`,
        [`mission-completed/${progressId}`],
      );
      expect(outbox.rows[0]?.c).toBe(1);

      // Retry completion outbox is idempotent.
      const again = await contributeMissionProgress(client, {
        missionVersionId: versionId,
        userId,
        sourceKind: 'REWARD_EVENT',
        sourceKey: 'reward-5',
        occurredAt: new Date('2026-05-01T05:00:00.000Z'),
      });
      expect(again.outcome).toBe('IGNORED_TERMINAL');
      const outbox2 = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM outbox_events
         WHERE dedupe_key = $1`,
        [`mission-completed/${progressId}`],
      );
      expect(outbox2.rows[0]?.c).toBe(1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('rejects contribution when definition is PAUSED', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: 'P16S2_PAUSED',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'NONE',
    });
    await pool.query(
      `UPDATE mission_definitions SET status = 'PAUSED'::content_status WHERE id = $1::uuid`,
      [defId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        contributeMissionProgress(client, {
          missionVersionId: versionId,
          userId,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: 'LIFETIME',
          occurredAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'MISSION_NOT_ACTIVE' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('concurrent identical source: one contribution wins', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: 'P16S2_RACE',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 2,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });
    const raceUser = await createTestUser(pool, '16200099');

    const a = await pool.connect();
    const b = await pool.connect();
    const watcher = await pool.connect();
    try {
      await a.query('BEGIN');
      const first = await contributeMissionProgress(a, {
        missionVersionId: versionId,
        userId: raceUser,
        sourceKind: 'REWARD_EVENT',
        sourceKey: 'same-ad',
        occurredAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      expect(first.outcome).toBe('CONTRIBUTED');

      const aPid = (await a.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!
        .pid;

      let bResult: Awaited<ReturnType<typeof contributeMissionProgress>> | undefined;
      const bPromise = (async () => {
        await b.query('BEGIN');
        bResult = await contributeMissionProgress(b, {
          missionVersionId: versionId,
          userId: raceUser,
          sourceKind: 'REWARD_EVENT',
          sourceKey: 'same-ad',
          occurredAt: new Date('2026-07-01T00:00:00.000Z'),
        });
        await b.query('COMMIT');
      })();

      const blocked = await waitForBlockedOnHolder(watcher, aPid, 8_000);
      expect(blocked).toBe(true);
      await a.query('COMMIT');
      await bPromise;
      expect(bResult?.outcome).toBe('ALREADY_CONTRIBUTED');

      const counts = await pool.query<{ progress_count: number; c: number }>(
        `SELECT p.progress_count,
                (SELECT count(*)::int FROM mission_progress_events e
                 WHERE e.mission_progress_id = p.id) AS c
         FROM mission_progress p
         WHERE p.mission_version_id = $1::uuid AND p.user_id = $2::uuid`,
        [versionId, raceUser],
      );
      expect(counts.rows[0]?.progress_count).toBe(1);
      expect(counts.rows[0]?.c).toBe(1);
    } finally {
      try {
        await a.query('ROLLBACK');
      } catch {
        // ignore
      }
      try {
        await b.query('ROLLBACK');
      } catch {
        // ignore
      }
      a.release();
      b.release();
      watcher.release();
    }
  });

  it('WEEKLY reset fails closed at contribution time', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: 'P16S2_WEEKLY',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'WEEKLY',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        contributeMissionProgress(client, {
          missionVersionId: versionId,
          userId,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: 'w',
          occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(MissionDomainError);
      await expect(
        contributeMissionProgress(client, {
          missionVersionId: versionId,
          userId,
          sourceKind: 'AUTHENTICATED_LOGIN_DAY',
          sourceKey: 'w',
          occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'MISSION_PERIOD_WEEKLY_NOT_CONFIGURED' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
