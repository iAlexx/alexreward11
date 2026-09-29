import type { Pool, PoolClient } from 'pg';

export async function withMissionProducerTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface MissionProducerBatchResult {
  readonly examined: number;
  readonly contributed: number;
  readonly alreadyContributed: number;
  readonly ignored: number;
  readonly errors: number;
}

export function emptyProducerBatchResult(): {
  examined: number;
  contributed: number;
  alreadyContributed: number;
  ignored: number;
  errors: number;
} {
  return {
    examined: 0,
    contributed: 0,
    alreadyContributed: 0,
    ignored: 0,
    errors: 0,
  };
}

export function tallyContributeOutcome(
  result: {
    examined: number;
    contributed: number;
    alreadyContributed: number;
    ignored: number;
    errors: number;
  },
  outcome: string,
): void {
  result.examined += 1;
  if (outcome === 'CONTRIBUTED') result.contributed += 1;
  else if (outcome === 'ALREADY_CONTRIBUTED') result.alreadyContributed += 1;
  else result.ignored += 1;
}

/** Mission versions eligible for producer redrive (historical SUPERSEDED included). */
export const PRODUCER_MISSION_VERSION_STATUS_SQL = `mv.status IN ('ACTIVE'::rule_version_status, 'SUPERSEDED'::rule_version_status)`;

export interface DailyLoginCandidate {
  readonly mission_version_id: string;
  readonly user_id: string;
  readonly occurred_at: Date;
  readonly day_key: string;
}

/**
 * Uncontributed login-day evidence pairs (version × user × UTC day), oldest first.
 */
export async function selectDailyLoginContributionCandidates(
  client: PoolClient,
  limit: number,
): Promise<readonly DailyLoginCandidate[]> {
  const result = await client.query<DailyLoginCandidate>(
    `SELECT mv.id AS mission_version_id,
            day.user_id,
            day.occurred_at,
            day.day_key
     FROM mission_versions mv
     INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
     INNER JOIN LATERAL (
       SELECT s.user_id,
              MIN(s.created_at) AS occurred_at,
              ('DAY:' || to_char((MIN(s.created_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')) AS day_key
       FROM user_sessions s
       GROUP BY s.user_id, ((s.created_at AT TIME ZONE 'UTC')::date)
     ) day ON true
     WHERE md.status = 'ACTIVE'
       AND mv.condition_type = 'DAILY_LOGIN'::mission_condition_type
       AND ${PRODUCER_MISSION_VERSION_STATUS_SQL}
       AND (mv.start_at IS NULL OR day.occurred_at >= mv.start_at)
       AND (mv.end_at IS NULL OR day.occurred_at < mv.end_at)
       AND NOT EXISTS (
         SELECT 1
         FROM mission_progress mp
         INNER JOIN mission_progress_events mpe ON mpe.mission_progress_id = mp.id
         WHERE mp.mission_version_id = mv.id
           AND mp.user_id = day.user_id
           AND mpe.source_kind = 'AUTHENTICATED_LOGIN_DAY'
           AND mpe.source_key = day.day_key
       )
     ORDER BY day.occurred_at ASC, mv.id ASC, day.user_id ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export interface ValidAdCandidate {
  readonly mission_version_id: string;
  readonly reward_event_id: string;
  readonly user_id: string;
  readonly available_at: Date;
}

export async function selectValidAdContributionCandidates(
  client: PoolClient,
  limit: number,
): Promise<readonly ValidAdCandidate[]> {
  const result = await client.query<ValidAdCandidate>(
    `SELECT mv.id AS mission_version_id,
            re.id AS reward_event_id,
            re.user_id,
            re.available_at
     FROM reward_events re
     INNER JOIN mission_versions mv ON mv.condition_type = 'VALID_AD_COUNT'::mission_condition_type
     INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
     WHERE re.source_type = 'AD'::reward_source_type
       AND re.state = 'AVAILABLE'::reward_event_state
       AND re.available_at IS NOT NULL
       AND md.status = 'ACTIVE'
       AND ${PRODUCER_MISSION_VERSION_STATUS_SQL}
       AND (mv.start_at IS NULL OR re.available_at >= mv.start_at)
       AND (mv.end_at IS NULL OR re.available_at < mv.end_at)
       AND NOT EXISTS (
         SELECT 1
         FROM mission_progress mp
         INNER JOIN mission_progress_events mpe ON mpe.mission_progress_id = mp.id
         WHERE mp.mission_version_id = mv.id
           AND mp.user_id = re.user_id
           AND mpe.source_kind = 'REWARD_EVENT'
           AND mpe.source_key = re.id::text
       )
     ORDER BY re.available_at ASC, re.id ASC, mv.id ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function selectStreakProducerUserIds(
  client: PoolClient,
  missionVersionId: string,
  limit: number,
): Promise<readonly string[]> {
  const result = await client.query<{ user_id: string }>(
    `SELECT s.user_id
     FROM user_sessions s
     WHERE EXISTS (
       SELECT 1
       FROM mission_versions mv
       WHERE mv.id = $1::uuid
         AND (mv.start_at IS NULL OR s.created_at >= mv.start_at)
         AND (mv.end_at IS NULL OR s.created_at < mv.end_at)
     )
     GROUP BY s.user_id
     ORDER BY MIN(COALESCE(
       (SELECT cp.last_evaluated_at
        FROM mission_streak_producer_checkpoints cp
        WHERE cp.mission_version_id = $1::uuid
          AND cp.user_id = s.user_id),
       '1970-01-01T00:00:00.000Z'::timestamptz
     )) ASC,
     s.user_id ASC
     LIMIT $2`,
    [missionVersionId, limit],
  );
  return result.rows.map((row) => row.user_id);
}

export async function touchStreakProducerCheckpoint(
  client: PoolClient,
  missionVersionId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO mission_streak_producer_checkpoints (
       mission_version_id, user_id, last_evaluated_at
     ) VALUES ($1::uuid, $2::uuid, now())
     ON CONFLICT (mission_version_id, user_id)
     DO UPDATE SET last_evaluated_at = now(), updated_at = now()`,
    [missionVersionId, userId],
  );
}
