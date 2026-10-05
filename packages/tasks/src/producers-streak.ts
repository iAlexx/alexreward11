import type { Pool, PoolClient } from 'pg';

import { contributeMissionProgress } from './contribute.js';
import { parseMissionEligibilityPolicy } from './eligibility-policy.js';
import { formatUtcDayKey, utcDayWindow } from './period.js';
import {
  emptyProducerBatchResult,
  PRODUCER_MISSION_VERSION_STATUS_SQL,
  selectStreakProducerUserIds,
  tallyContributeOutcome,
  touchStreakProducerCheckpoint,
  withMissionProducerTx,
  type MissionProducerBatchResult,
} from './producer-shared.js';

interface StreakMissionVersion {
  readonly id: string;
  readonly target: number;
  readonly eligibility_policy: unknown;
  readonly start_at: Date | null;
  readonly end_at: Date | null;
}

interface LoginDay {
  readonly user_id: string;
  readonly day_key: string;
  readonly occurred_at: Date;
}

function utcDayNumber(asOf: Date): number {
  return Math.floor(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) / 86_400_000);
}

function parseDayKeyToDate(dayKey: string): Date {
  const raw = dayKey.startsWith('DAY:') ? dayKey.slice(4) : dayKey;
  const [y, m, d] = raw.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function streakPeriodKey(sequenceStart: Date): string {
  const y = sequenceStart.getUTCFullYear();
  const m = String(sequenceStart.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sequenceStart.getUTCDate()).padStart(2, '0');
  return `STREAK:${y}-${m}-${d}`;
}

async function loadUserLoginDays(
  client: PoolClient,
  userId: string,
): Promise<LoginDay[]> {
  const rows = await client.query<{ occurred_at: Date }>(
    `SELECT MIN(s.created_at) AS occurred_at
     FROM user_sessions s
     WHERE s.user_id = $1::uuid
     GROUP BY ((s.created_at AT TIME ZONE 'UTC')::date)
     ORDER BY MIN(s.created_at) ASC`,
    [userId],
  );
  return rows.rows.map((row) => ({
    user_id: userId,
    day_key: formatUtcDayKey(row.occurred_at),
    occurred_at: row.occurred_at,
  }));
}

async function expireOpenStreakProgress(
  client: PoolClient,
  missionVersionId: string,
  userId: string,
  periodKey: string,
): Promise<void> {
  await client.query(
    `UPDATE mission_progress
     SET state = 'EXPIRED'::task_progress_state,
         updated_at = now()
     WHERE mission_version_id = $1::uuid
       AND user_id = $2::uuid
       AND period_key = $3
       AND state IN ('NOT_STARTED'::task_progress_state, 'IN_PROGRESS'::task_progress_state)`,
    [missionVersionId, userId, periodKey],
  );
}

/**
 * STREAK_MILESTONE capability using only explicit typed streak config.
 * No default grace/timezone. Unsupported config → skip (fail closed).
 */
export async function processStreakMissionContributionsBatch(
  pool: Pool,
  options: { readonly limit: number },
): Promise<MissionProducerBatchResult> {
  const limit = Math.max(1, Math.min(options.limit, 200));
  const result = { ...emptyProducerBatchResult() };

  const versions = await withMissionProducerTx(pool, async (client) => {
    return (
      await client.query<StreakMissionVersion>(
        `SELECT mv.id, mv.target, mv.eligibility_policy, mv.start_at, mv.end_at
         FROM mission_versions mv
         INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
         WHERE md.status = 'ACTIVE'
           AND mv.condition_type = 'STREAK_MILESTONE'
           AND ${PRODUCER_MISSION_VERSION_STATUS_SQL}`,
      )
    ).rows;
  });
  if (versions.length === 0) {
    return result;
  }

  for (const version of versions) {
    let streakPolicy;
    try {
      streakPolicy = parseMissionEligibilityPolicy(version.eligibility_policy).streak;
    } catch {
      result.errors += 1;
      continue;
    }
    if (streakPolicy === null) {
      continue;
    }
    if (streakPolicy.timeZone !== 'UTC' || streakPolicy.source !== 'AUTHENTICATED_LOGIN_DAY') {
      continue;
    }
    const graceDays = streakPolicy.graceDays;
    const maxGapDays = graceDays + 1;

    const userIds = await withMissionProducerTx(pool, async (client) =>
      selectStreakProducerUserIds(client, version.id, limit),
    );

    for (const userId of userIds) {
      try {
        await withMissionProducerTx(pool, async (client) => {
          const days = await loadUserLoginDays(client, userId);
          if (days.length === 0) {
            await touchStreakProducerCheckpoint(client, version.id, userId);
            return;
          }

          let sequenceStart = parseDayKeyToDate(days[0]!.day_key);
          let previousDay = sequenceStart;
          let periodKey = streakPeriodKey(sequenceStart);

          for (const day of days) {
            const dayDate = parseDayKeyToDate(day.day_key);
            if (version.start_at !== null && day.occurred_at < version.start_at) continue;
            if (version.end_at !== null && !(day.occurred_at < version.end_at)) continue;

            const gap = utcDayNumber(dayDate) - utcDayNumber(previousDay);
            if (gap > maxGapDays) {
              await expireOpenStreakProgress(client, version.id, userId, periodKey);
              sequenceStart = dayDate;
              periodKey = streakPeriodKey(sequenceStart);
            }
            previousDay = dayDate;

            const outcome = await contributeMissionProgress(client, {
              missionVersionId: version.id,
              userId,
              sourceKind: 'STREAK_DAY',
              sourceKey: day.day_key,
              occurredAt: day.occurred_at,
              periodKeyOverride: periodKey,
            });
            tallyContributeOutcome(result, outcome.outcome);
          }
          await touchStreakProducerCheckpoint(client, version.id, userId);
        });
      } catch {
        result.examined += 1;
        result.errors += 1;
      }
    }
  }

  return result;
}

/** Exported for tests — pure gap helper using UTC day arithmetic. */
export function streakGapAllowsContinuation(
  previousDay: Date,
  nextDay: Date,
  graceDays: number,
): boolean {
  const gap = utcDayNumber(utcDayWindow(nextDay).periodStart) - utcDayNumber(utcDayWindow(previousDay).periodStart);
  return gap <= graceDays + 1;
}
