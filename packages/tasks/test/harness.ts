/**
 * Phase 16 mission test helpers.
 * Destructive against PHASE16_DATABASE_URL (or PHASE16_MISSION_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool, type PoolClient } from 'pg';

const explicitUrl = process.env.PHASE16_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE16_MISSION_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase16DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

export async function withClient<T>(
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

export async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

export async function createTestUser(
  pool: Pool,
  telegramUserId: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function insertMissionDefinition(
  pool: Pool,
  input: {
    readonly code: string;
    readonly nameKey?: string;
    readonly status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_definitions (code, name_key, status)
     VALUES ($1, $2, $3::content_status)
     RETURNING id`,
    [input.code, input.nameKey ?? `mission.${input.code}`, input.status ?? 'ACTIVE'],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission definition insert failed');
  return id;
}

export async function insertMissionVersion(
  pool: Pool,
  input: {
    readonly missionDefinitionId: string;
    readonly missionVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly startAt?: Date | null;
    readonly endAt?: Date | null;
    readonly target?: number;
    readonly conditionType?: string;
    readonly resetPolicy?: string;
    readonly nameKey?: string;
    readonly rewardSourceType?: string;
    readonly rewardRuleId?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_versions (
       mission_definition_id, mission_version, name_key, condition_type, target,
       reset_policy, status, start_at, end_at, reward_source_type, reward_rule_id
     ) VALUES (
       $1::uuid, $2, $3, $4::mission_condition_type, $5,
       $6::mission_reset_policy, $7::rule_version_status,
       $8::timestamptz, $9::timestamptz,
       $10::reward_source_type, $11::uuid
     )
     RETURNING id`,
    [
      input.missionDefinitionId,
      input.missionVersion,
      input.nameKey ?? 'mission.test.name',
      input.conditionType ?? 'DAILY_LOGIN',
      input.target ?? 1,
      input.resetPolicy ?? 'NONE',
      input.status,
      input.startAt === undefined ? null : input.startAt === null ? null : input.startAt.toISOString(),
      input.endAt === undefined ? null : input.endAt === null ? null : input.endAt.toISOString(),
      input.rewardSourceType ?? 'MISSION',
      input.rewardRuleId ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission version insert failed');
  return id;
}

export async function insertMissionProgress(
  pool: Pool,
  input: {
    readonly missionVersionId: string;
    readonly userId: string;
    readonly periodKey?: string;
    readonly target: number;
    readonly progressCount?: number;
    readonly state?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED';
    readonly startedAt?: Date | null;
    readonly completedAt?: Date | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_progress (
       mission_version_id, user_id, period_key, progress_count, target, state,
       started_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6::task_progress_state,
       $7::timestamptz, $8::timestamptz
     )
     RETURNING id`,
    [
      input.missionVersionId,
      input.userId,
      input.periodKey ?? 'LIFETIME',
      input.progressCount ?? 0,
      input.target,
      input.state ?? 'NOT_STARTED',
      input.startedAt === undefined || input.startedAt === null
        ? null
        : input.startedAt.toISOString(),
      input.completedAt === undefined || input.completedAt === null
        ? null
        : input.completedAt.toISOString(),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission progress insert failed');
  return id;
}

/** Deterministic wait until another backend is blocked on holderPid's granted locks. */
export async function waitForBlockedOnHolder(
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
