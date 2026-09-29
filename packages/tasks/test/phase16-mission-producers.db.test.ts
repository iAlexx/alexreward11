import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  processDailyLoginMissionContributionsBatch,
  processStreakMissionContributionsBatch,
  processValidAdMissionContributionsBatch,
  streakGapAllowsContinuation,
} from '../src/index.js';
import {
  createPool,
  createTestUser,
  insertMissionDefinition,
  insertMissionVersion,
  phase16DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

async function insertSession(
  pool: Pool,
  userId: string,
  createdAt: Date,
): Promise<void> {
  const secret = createHash('sha256').update(randomBytes(32)).digest('hex');
  await pool.query(
    `INSERT INTO user_sessions (
       user_id, session_secret_hash, expires_at, created_at, last_seen_at
     ) VALUES (
       $1::uuid, $2, $3::timestamptz, $4::timestamptz, $4::timestamptz
     )`,
    [
      userId,
      `sess_${secret}`,
      new Date(createdAt.getTime() + 86_400_000).toISOString(),
      createdAt.toISOString(),
    ],
  );
}

async function insertAdReward(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly state: 'AVAILABLE' | 'PENDING' | 'REVERSED';
    readonly availableAt: Date | null;
    readonly sourceId?: string;
  },
): Promise<string> {
  const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const assetId = asset.rows[0]?.id;
  if (assetId === undefined) throw new Error('USDT missing');
  const sourceId = input.sourceId ?? crypto.randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reward_events (
       user_id, source_type, source_id, asset_id, amount_atomic, state, available_at
     ) VALUES (
       $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, 100,
       $4::reward_event_state, $5::timestamptz
     ) RETURNING id`,
    [
      input.userId,
      sourceId,
      assetId,
      input.state,
      input.availableAt?.toISOString() ?? null,
    ],
  );
  return result.rows[0]!.id;
}

describe.skipIf(phase16DatabaseUrl === '')('Phase 16 Step 3 source producers (DB)', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = createPool(phase16DatabaseUrl);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('daily login: multiple sessions same UTC day contribute once; replay safe', async () => {
    const userId = await createTestUser(pool, '16300001');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16S3_LOGIN',
      status: 'ACTIVE',
    });
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'DAILY',
    });

    await insertSession(pool, userId, new Date('2026-04-10T08:00:00.000Z'));
    await insertSession(pool, userId, new Date('2026-04-10T20:00:00.000Z'));

    const first = await processDailyLoginMissionContributionsBatch(pool, { limit: 50 });
    expect(first.contributed).toBeGreaterThanOrEqual(1);

    const progress = await pool.query<{ progress_count: number; state: string; c: number }>(
      `SELECT p.progress_count, p.state::text AS state,
              (SELECT count(*)::int FROM mission_progress_events e
               WHERE e.mission_progress_id = p.id) AS c
       FROM mission_progress p
       WHERE p.user_id = $1::uuid`,
      [userId],
    );
    expect(progress.rows[0]?.progress_count).toBe(1);
    expect(progress.rows[0]?.state).toBe('COMPLETED');
    expect(progress.rows[0]?.c).toBe(1);

    const second = await processDailyLoginMissionContributionsBatch(pool, { limit: 50 });
    expect(second.contributed).toBe(0);
  });

  it('VALID_AD: 3 and 10 missions; PENDING/REVERSED excluded; replay safe', async () => {
    const userId = await createTestUser(pool, '16300002');
    const def3 = await insertMissionDefinition(pool, { code: 'P16S3_AD3', status: 'ACTIVE' });
    const v3 = await insertMissionVersion(pool, {
      missionDefinitionId: def3,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });
    const def10 = await insertMissionDefinition(pool, { code: 'P16S3_AD10', status: 'ACTIVE' });
    const v10 = await insertMissionVersion(pool, {
      missionDefinitionId: def10,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 10,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });

    await insertAdReward(pool, {
      userId,
      state: 'PENDING',
      availableAt: null,
    });
    await insertAdReward(pool, {
      userId,
      state: 'REVERSED',
      availableAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const availableIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      availableIds.push(
        await insertAdReward(pool, {
          userId,
          state: 'AVAILABLE',
          availableAt: new Date(`2026-05-02T0${i}:00:00.000Z`),
        }),
      );
    }

    await processValidAdMissionContributionsBatch(pool, { limit: 100 });

    const p3 = await pool.query<{ progress_count: number; state: string }>(
      `SELECT progress_count, state::text AS state FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
      [v3, userId],
    );
    const p10 = await pool.query<{ progress_count: number; state: string }>(
      `SELECT progress_count, state::text AS state FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
      [v10, userId],
    );
    expect(p3.rows[0]?.progress_count).toBe(3);
    expect(p3.rows[0]?.state).toBe('COMPLETED');
    expect(p10.rows[0]?.progress_count).toBe(3);
    expect(p10.rows[0]?.state).toBe('IN_PROGRESS');

    // Same AD source_key exists on both progress rows.
    const shared = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_progress_events
       WHERE source_kind = 'REWARD_EVENT' AND source_key = $1`,
      [availableIds[0]],
    );
    expect(shared.rows[0]?.c).toBe(2);

    const replay = await processValidAdMissionContributionsBatch(pool, { limit: 100 });
    expect(replay.contributed).toBe(0);
  });

  it('streak: consecutive days; grace gap; no-config fail closed', async () => {
    expect(
      streakGapAllowsContinuation(
        new Date('2026-06-01T00:00:00.000Z'),
        new Date('2026-06-02T00:00:00.000Z'),
        0,
      ),
    ).toBe(true);
    expect(
      streakGapAllowsContinuation(
        new Date('2026-06-01T00:00:00.000Z'),
        new Date('2026-06-03T00:00:00.000Z'),
        0,
      ),
    ).toBe(false);
    expect(
      streakGapAllowsContinuation(
        new Date('2026-06-01T00:00:00.000Z'),
        new Date('2026-06-03T00:00:00.000Z'),
        1,
      ),
    ).toBe(true);

    const userId = await createTestUser(pool, '16300003');
    const noCfg = await insertMissionDefinition(pool, {
      code: 'P16S3_STREAK_NOCFG',
      status: 'ACTIVE',
    });
    await insertMissionVersion(pool, {
      missionDefinitionId: noCfg,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
      conditionType: 'STREAK_MILESTONE',
      resetPolicy: 'NONE',
      eligibilityPolicy: {},
    });

    const okDef = await insertMissionDefinition(pool, {
      code: 'P16S3_STREAK_OK',
      status: 'ACTIVE',
    });
    const streakVersion = await insertMissionVersion(pool, {
      missionDefinitionId: okDef,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 3,
      conditionType: 'STREAK_MILESTONE',
      resetPolicy: 'NONE',
      eligibilityPolicy: {
        streak: {
          source: 'AUTHENTICATED_LOGIN_DAY',
          timeZone: 'UTC',
          graceDays: 1,
        },
      },
    });

    await insertSession(pool, userId, new Date('2026-06-01T10:00:00.000Z'));
    await insertSession(pool, userId, new Date('2026-06-02T10:00:00.000Z'));
    // Gap of 2 days with graceDays=1 → maxGap=2, so day 4 continues? 
    // gap from June 2 to June 4 = 2 days, maxGap = grace+1 = 2 → allowed
    await insertSession(pool, userId, new Date('2026-06-04T10:00:00.000Z'));

    await processStreakMissionContributionsBatch(pool, { limit: 50 });

    const noCfgProgress = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_progress p
       INNER JOIN mission_versions mv ON mv.id = p.mission_version_id
       INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
       WHERE md.code = 'P16S3_STREAK_NOCFG' AND p.user_id = $1::uuid`,
      [userId],
    );
    expect(noCfgProgress.rows[0]?.c).toBe(0);

    const streak = await pool.query<{
      progress_count: number;
      state: string;
      period_key: string;
    }>(
      `SELECT progress_count, state::text AS state, period_key
       FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
      [streakVersion, userId],
    );
    expect(streak.rows.length).toBe(1);
    expect(streak.rows[0]?.period_key).toBe('STREAK:2026-06-01');
    expect(streak.rows[0]?.progress_count).toBe(3);
    expect(streak.rows[0]?.state).toBe('COMPLETED');

    // New sequence after large gap
    const user2 = await createTestUser(pool, '16300004');
    await insertSession(pool, user2, new Date('2026-07-01T10:00:00.000Z'));
    await insertSession(pool, user2, new Date('2026-07-05T10:00:00.000Z')); // gap 4 > 2
    await processStreakMissionContributionsBatch(pool, { limit: 50 });

    const seq = await pool.query<{ period_key: string; state: string; progress_count: number }>(
      `SELECT period_key, state::text AS state, progress_count
       FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid
       ORDER BY period_key`,
      [streakVersion, user2],
    );
    expect(seq.rows.some((r) => r.period_key === 'STREAK:2026-07-01')).toBe(true);
    expect(seq.rows.some((r) => r.period_key === 'STREAK:2026-07-05')).toBe(true);
    const expired = seq.rows.find((r) => r.period_key === 'STREAK:2026-07-01');
    expect(expired?.state).toBe('EXPIRED');
  });

  it('daily login batch limit=3 eventually processes all actionable days', async () => {
    const userId = await createTestUser(pool, '16301001');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16REM_LOGIN_STARVE',
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
      resetPolicy: 'DAILY',
    });

    for (let d = 1; d <= 10; d += 1) {
      const day = String(d).padStart(2, '0');
      await insertSession(pool, userId, new Date(`2026-08-${day}T12:00:00.000Z`));
    }

    const countEvents = async (): Promise<number> => {
      const row = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM mission_progress_events mpe
         INNER JOIN mission_progress mp ON mp.id = mpe.mission_progress_id
         WHERE mp.mission_version_id = $1::uuid AND mp.user_id = $2::uuid`,
        [versionId, userId],
      );
      return row.rows[0]?.c ?? 0;
    };

    for (let round = 0; round < 20; round += 1) {
      await processDailyLoginMissionContributionsBatch(pool, { limit: 3 });
      if ((await countEvents()) >= 10) break;
    }
    expect(await countEvents()).toBe(10);

    const beforeIdle = await countEvents();
    await processDailyLoginMissionContributionsBatch(pool, { limit: 3 });
    expect(await countEvents()).toBe(beforeIdle);
  });

  it('VALID_AD batch limit=3 eventually processes all actionable ads when target >= evidence', async () => {
    const userId = await createTestUser(pool, '16301002');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16REM_AD_STARVE',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2010-01-01T00:00:00.000Z'),
      endAt: null,
      target: 8,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });

    for (let i = 0; i < 8; i += 1) {
      await insertAdReward(pool, {
        userId,
        state: 'AVAILABLE',
        availableAt: new Date(`2015-01-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`),
      });
    }

    const countAdEvents = async (): Promise<number> => {
      const row = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c
         FROM mission_progress_events mpe
         INNER JOIN mission_progress mp ON mp.id = mpe.mission_progress_id
         WHERE mp.mission_version_id = $1::uuid AND mp.user_id = $2::uuid`,
        [versionId, userId],
      );
      return row.rows[0]?.c ?? 0;
    };

    for (let round = 0; round < 100; round += 1) {
      await processValidAdMissionContributionsBatch(pool, { limit: 3 });
      if ((await countAdEvents()) >= 8) break;
    }
    expect(await countAdEvents()).toBe(8);

    const beforeIdle = await countAdEvents();
    await processValidAdMissionContributionsBatch(pool, { limit: 3 });
    expect(await countAdEvents()).toBe(beforeIdle);
  });

  it('DAILY_LOGIN target=1 NONE: terminal LIFETIME excludes later login days', async () => {
    const userId = await createTestUser(pool, '16302001');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16FIN_LOGIN_TERM',
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

    for (let d = 1; d <= 5; d += 1) {
      await insertSession(pool, userId, new Date(`2026-11-0${d}T12:00:00.000Z`));
    }

    let ignoredTotal = 0;
    for (let round = 0; round < 10; round += 1) {
      const batch = await processDailyLoginMissionContributionsBatch(pool, { limit: 3 });
      ignoredTotal += batch.ignored;
      if (batch.examined === 0) break;
    }

    const events = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM mission_progress_events mpe
       INNER JOIN mission_progress mp ON mp.id = mpe.mission_progress_id
       WHERE mp.mission_version_id = $1::uuid AND mp.user_id = $2::uuid`,
      [versionId, userId],
    );
    expect(events.rows[0]?.c).toBe(1);
    expect(ignoredTotal).toBe(0);

    const idle = await processDailyLoginMissionContributionsBatch(pool, { limit: 3 });
    expect(idle.examined).toBe(0);
    expect(idle.ignored).toBe(0);
  });

  it('VALID_AD target=1 NONE: terminal LIFETIME excludes remaining ADs', async () => {
    const userId = await createTestUser(pool, '16302002');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16FIN_AD_TERM',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2010-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });

    for (let i = 0; i < 8; i += 1) {
      await insertAdReward(pool, {
        userId,
        state: 'AVAILABLE',
        availableAt: new Date(`2016-02-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`),
      });
    }

    let ignoredTotal = 0;
    for (let round = 0; round < 20; round += 1) {
      const batch = await processValidAdMissionContributionsBatch(pool, { limit: 3 });
      ignoredTotal += batch.ignored;
      if (batch.examined === 0) break;
    }

    const events = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM mission_progress_events mpe
       INNER JOIN mission_progress mp ON mp.id = mpe.mission_progress_id
       WHERE mp.mission_version_id = $1::uuid AND mp.user_id = $2::uuid`,
      [versionId, userId],
    );
    expect(events.rows[0]?.c).toBe(1);
    expect(ignoredTotal).toBe(0);

    const idle = await processValidAdMissionContributionsBatch(pool, { limit: 3 });
    expect(idle.examined).toBe(0);
  });

  it('cross-user: terminal DAILY_LOGIN evidence does not starve actionable user B', async () => {
    const userA = await createTestUser(pool, '16302003');
    const userB = await createTestUser(pool, '16302004');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16FIN_LOGIN_XUSER',
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

    for (let d = 1; d <= 10; d += 1) {
      await insertSession(pool, userA, new Date(`2026-12-${String(d).padStart(2, '0')}T08:00:00.000Z`));
    }
    await processDailyLoginMissionContributionsBatch(pool, { limit: 3 });

    await insertSession(pool, userB, new Date('2026-12-15T08:00:00.000Z'));

    let sawB = false;
    for (let round = 0; round < 20; round += 1) {
      await processDailyLoginMissionContributionsBatch(pool, { limit: 2 });
      const b = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM mission_progress
         WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
        [versionId, userB],
      );
      if ((b.rows[0]?.c ?? 0) > 0) {
        sawB = true;
        break;
      }
    }
    expect(sawB).toBe(true);
  });

  it('cross-user: terminal VALID_AD evidence does not starve actionable user B', async () => {
    const userA = await createTestUser(pool, '16302005');
    const userB = await createTestUser(pool, '16302006');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16FIN_AD_XUSER',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2010-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'VALID_AD_COUNT',
      resetPolicy: 'NONE',
    });

    for (let i = 0; i < 10; i += 1) {
      await insertAdReward(pool, {
        userId: userA,
        state: 'AVAILABLE',
        availableAt: new Date(`2017-03-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`),
      });
    }
    await processValidAdMissionContributionsBatch(pool, { limit: 3 });

    await insertAdReward(pool, {
      userId: userB,
      state: 'AVAILABLE',
      availableAt: new Date('2017-04-01T12:00:00.000Z'),
    });

    let sawB = false;
    for (let round = 0; round < 20; round += 1) {
      await processValidAdMissionContributionsBatch(pool, { limit: 2 });
      const b = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM mission_progress
         WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
        [versionId, userB],
      );
      if ((b.rows[0]?.c ?? 0) > 0) {
        sawB = true;
        break;
      }
    }
    expect(sawB).toBe(true);
  });

  it('STREAK batch limit=3 eventually evaluates all users with login evidence', async () => {
    const defId = await insertMissionDefinition(pool, {
      code: 'P16REM_STREAK_USERS',
      status: 'ACTIVE',
    });
    const versionId = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'ACTIVE',
      startAt: new Date('2020-01-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'STREAK_MILESTONE',
      resetPolicy: 'NONE',
      eligibilityPolicy: {
        streak: { source: 'AUTHENTICATED_LOGIN_DAY', timeZone: 'UTC', graceDays: 0 },
      },
    });

    const userIds: string[] = [];
    for (let u = 0; u < 8; u += 1) {
      const userId = await createTestUser(pool, `1630101${u}`);
      userIds.push(userId);
      await insertSession(pool, userId, new Date(`2026-10-${String(u + 1).padStart(2, '0')}T10:00:00.000Z`));
    }

    const touched = new Set<string>();
    for (let round = 0; round < 30; round += 1) {
      await processStreakMissionContributionsBatch(pool, { limit: 3 });
      const rows = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM mission_streak_producer_checkpoints
         WHERE mission_version_id = $1::uuid`,
        [versionId],
      );
      for (const row of rows.rows) {
        if (userIds.includes(row.user_id)) touched.add(row.user_id);
      }
      if (touched.size >= userIds.length) break;
    }
    expect(userIds.every((id) => touched.has(id))).toBe(true);
  });

  it('historical SUPERSEDED version redrive contributes unprocessed evidence', async () => {
    const userId = await createTestUser(pool, '16301003');
    const defId = await insertMissionDefinition(pool, {
      code: 'P16REM_SUPERSEDED',
      status: 'ACTIVE',
    });
    const v1 = await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 1,
      status: 'SUPERSEDED',
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: new Date('2026-06-01T00:00:00.000Z'),
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'DAILY',
    });
    await insertMissionVersion(pool, {
      missionDefinitionId: defId,
      missionVersion: 2,
      status: 'ACTIVE',
      startAt: new Date('2026-06-01T00:00:00.000Z'),
      endAt: null,
      target: 1,
      conditionType: 'DAILY_LOGIN',
      resetPolicy: 'DAILY',
    });

    await insertSession(pool, userId, new Date('2026-03-15T12:00:00.000Z'));

    const batch = await processDailyLoginMissionContributionsBatch(pool, { limit: 10 });
    expect(batch.contributed).toBeGreaterThanOrEqual(1);

    const onV1 = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM mission_progress
       WHERE mission_version_id = $1::uuid AND user_id = $2::uuid`,
      [v1, userId],
    );
    expect(onV1.rows[0]?.c).toBe(1);
  });
});
