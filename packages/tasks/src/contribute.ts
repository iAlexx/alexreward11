import type { PoolClient } from 'pg';

import {
  assertSourceMatchesCondition,
  type MissionProgressSourceKind,
  validateMissionVersionStructure,
} from './condition.js';
import { MissionDomainError } from './errors.js';
import {
  getMissionVersionById,
  mapMissionDefinitionRow,
  mapMissionVersionRow,
  type MissionDefinition,
  type MissionVersion,
} from './mission-version.js';
import { insertMissionOutboxEvent } from './outbox.js';
import { resolveMissionPeriod } from './period.js';

export type ContributeMissionProgressResult =
  | {
      readonly outcome: 'CONTRIBUTED';
      readonly progressId: string;
      readonly progressCount: number;
      readonly target: number;
      readonly state: 'IN_PROGRESS' | 'COMPLETED';
      readonly periodKey: string;
      readonly completed: boolean;
    }
  | {
      readonly outcome: 'ALREADY_CONTRIBUTED';
      readonly progressId: string;
      readonly progressCount: number;
      readonly target: number;
      readonly state: string;
      readonly periodKey: string;
    }
  | {
      readonly outcome: 'IGNORED_TERMINAL';
      readonly progressId: string;
      readonly progressCount: number;
      readonly target: number;
      readonly state: string;
      readonly periodKey: string;
    };

export interface ContributeMissionProgressInput {
  readonly missionVersionId: string;
  readonly userId: string;
  readonly sourceKind: MissionProgressSourceKind;
  readonly sourceKey: string;
  readonly occurredAt: Date;
  /**
   * Internal STREAK_MILESTONE producer only.
   * Clients must never supply periodKey — public callers omit this.
   */
  readonly periodKeyOverride?: string;
}

interface ProgressRow {
  readonly id: string;
  readonly mission_version_id: string;
  readonly user_id: string;
  readonly period_key: string;
  readonly progress_count: number;
  readonly target: number;
  readonly state: string;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}

function assertContributionWindow(
  version: MissionVersion,
  occurredAt: Date,
): void {
  if (version.startAt !== null && occurredAt < version.startAt) {
    throw new MissionDomainError(
      'MISSION_CONTRIBUTION_WINDOW_CLOSED',
      'occurredAt is before mission version start_at',
      {
        missionVersionId: version.id,
        occurredAt: occurredAt.toISOString(),
        startAt: version.startAt.toISOString(),
      },
    );
  }
  if (version.endAt !== null && !(occurredAt < version.endAt)) {
    throw new MissionDomainError(
      'MISSION_CONTRIBUTION_WINDOW_CLOSED',
      'occurredAt is outside mission version [start_at, end_at)',
      {
        missionVersionId: version.id,
        occurredAt: occurredAt.toISOString(),
        endAt: version.endAt.toISOString(),
      },
    );
  }
}

/**
 * Lock definition then version (definition → version order).
 * Requires definition CURRENTLY ACTIVE. Version status may be historical
 * (redrive) as long as occurredAt ∈ [start_at, end_at).
 */
async function lockDefinitionAndVersionForContribution(
  client: PoolClient,
  missionVersionId: string,
): Promise<{ definition: MissionDefinition; version: MissionVersion }> {
  const versionProbe = await client.query<{ mission_definition_id: string }>(
    `SELECT mission_definition_id FROM mission_versions WHERE id = $1::uuid`,
    [missionVersionId],
  );
  const definitionId = versionProbe.rows[0]?.mission_definition_id;
  if (definitionId === undefined) {
    throw new MissionDomainError(
      'MISSION_VERSION_NOT_FOUND',
      `mission version ${missionVersionId} not found`,
      { missionVersionId },
    );
  }

  const defResult = await client.query<{
    id: string;
    code: string;
    name_key: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, code, name_key, status::text AS status, created_at
     FROM mission_definitions
     WHERE id = $1::uuid
     FOR SHARE`,
    [definitionId],
  );
  const defRow = defResult.rows[0];
  if (defRow === undefined) {
    throw new MissionDomainError(
      'MISSION_NOT_CONFIGURED',
      `mission definition ${definitionId} not found`,
      { missionDefinitionId: definitionId },
    );
  }
  const definition = mapMissionDefinitionRow(defRow);
  if (definition.status !== 'ACTIVE') {
    throw new MissionDomainError(
      'MISSION_NOT_ACTIVE',
      `mission definition status is ${definition.status}; new contributions require ACTIVE`,
      { missionDefinitionId: definition.id, status: definition.status },
    );
  }

  const versionResult = await client.query(
    `SELECT id, mission_definition_id, mission_version,
            name_key, description_key, condition_type::text AS condition_type,
            target, reset_policy::text AS reset_policy, eligibility_policy,
            required_membership_plan_id, reward_source_type::text AS reward_source_type,
            reward_rule_id, status::text AS status, start_at, end_at, created_at
     FROM mission_versions
     WHERE id = $1::uuid
     FOR SHARE`,
    [missionVersionId],
  );
  const versionRow = versionResult.rows[0];
  if (versionRow === undefined) {
    throw new MissionDomainError(
      'MISSION_VERSION_NOT_FOUND',
      `mission version ${missionVersionId} not found`,
      { missionVersionId },
    );
  }
  const version = mapMissionVersionRow(versionRow);
  return { definition, version };
}

async function lockOrInsertProgress(
  client: PoolClient,
  input: {
    readonly missionVersionId: string;
    readonly userId: string;
    readonly periodKey: string;
    readonly target: number;
  },
): Promise<ProgressRow> {
  await client.query(
    `INSERT INTO mission_progress (
       mission_version_id, user_id, period_key, progress_count, target, state
     ) VALUES (
       $1::uuid, $2::uuid, $3, 0, $4, 'NOT_STARTED'::task_progress_state
     )
     ON CONFLICT (mission_version_id, user_id, period_key) DO NOTHING`,
    [input.missionVersionId, input.userId, input.periodKey, input.target],
  );

  const locked = await client.query<ProgressRow>(
    `SELECT id, mission_version_id, user_id, period_key,
            progress_count, target, state::text AS state,
            started_at, completed_at
     FROM mission_progress
     WHERE mission_version_id = $1::uuid
       AND user_id = $2::uuid
       AND period_key = $3
     FOR UPDATE`,
    [input.missionVersionId, input.userId, input.periodKey],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new MissionDomainError('INTERNAL', 'mission_progress lock failed after upsert');
  }
  return row;
}

/**
 * Server-authoritative mission progress contribution.
 * Caller must NOT supply target/periodKey/counts/state/timestamps/delta.
 */
export async function contributeMissionProgress(
  client: PoolClient,
  input: ContributeMissionProgressInput,
): Promise<ContributeMissionProgressResult> {
  if (input.sourceKey.trim() === '') {
    throw new MissionDomainError('MISSION_INTEGRITY', 'sourceKey is required');
  }

  const { version } = await lockDefinitionAndVersionForContribution(
    client,
    input.missionVersionId,
  );

  if (version.status === 'DRAFT' || version.status === 'REVOKED') {
    throw new MissionDomainError(
      'MISSION_NOT_ACTIVE',
      `mission version status is ${version.status}; contributions require ACTIVE or SUPERSEDED redrive`,
      { missionVersionId: version.id, status: version.status },
    );
  }

  validateMissionVersionStructure(version);
  assertContributionWindow(version, input.occurredAt);
  assertSourceMatchesCondition(version, input.sourceKind);

  let periodKey: string;
  if (input.periodKeyOverride !== undefined) {
    if (
      version.conditionType !== 'STREAK_MILESTONE' ||
      input.sourceKind !== 'STREAK_DAY'
    ) {
      throw new MissionDomainError(
        'MISSION_INTEGRITY',
        'periodKeyOverride is only allowed for STREAK_MILESTONE STREAK_DAY contributions',
      );
    }
    if (!/^STREAK:\d{4}-\d{2}-\d{2}$/.test(input.periodKeyOverride)) {
      throw new MissionDomainError(
        'MISSION_INTEGRITY',
        'streak periodKeyOverride must be STREAK:YYYY-MM-DD',
        { periodKeyOverride: input.periodKeyOverride },
      );
    }
    periodKey = input.periodKeyOverride;
  } else {
    periodKey = resolveMissionPeriod(version.resetPolicy, input.occurredAt).periodKey;
  }

  const progress = await lockOrInsertProgress(client, {
    missionVersionId: version.id,
    userId: input.userId,
    periodKey,
    target: version.target,
  });

  if (progress.state === 'COMPLETED' || progress.state === 'EXPIRED') {
    const existingEvent = await client.query<{ id: string }>(
      `SELECT id FROM mission_progress_events
       WHERE mission_progress_id = $1::uuid
         AND source_kind = $2
         AND source_key = $3`,
      [progress.id, input.sourceKind, input.sourceKey],
    );
    if (existingEvent.rows[0]?.id !== undefined) {
      return {
        outcome: 'ALREADY_CONTRIBUTED',
        progressId: progress.id,
        progressCount: progress.progress_count,
        target: progress.target,
        state: progress.state,
        periodKey: progress.period_key,
      };
    }
    return {
      outcome: 'IGNORED_TERMINAL',
      progressId: progress.id,
      progressCount: progress.progress_count,
      target: progress.target,
      state: progress.state,
      periodKey: progress.period_key,
    };
  }

  const eventInsert = await client.query<{ id: string }>(
    `INSERT INTO mission_progress_events (
       mission_progress_id, mission_version_id, user_id, period_key,
       source_kind, source_key, progress_delta, occurred_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5, $6, 1, $7::timestamptz
     )
     ON CONFLICT (mission_progress_id, source_kind, source_key) DO NOTHING
     RETURNING id`,
    [
      progress.id,
      version.id,
      input.userId,
      periodKey,
      input.sourceKind,
      input.sourceKey,
      input.occurredAt.toISOString(),
    ],
  );

  if (eventInsert.rows[0]?.id === undefined) {
    const refreshed = await client.query<ProgressRow>(
      `SELECT id, mission_version_id, user_id, period_key,
              progress_count, target, state::text AS state,
              started_at, completed_at
       FROM mission_progress WHERE id = $1::uuid`,
      [progress.id],
    );
    const row = refreshed.rows[0]!;
    return {
      outcome: 'ALREADY_CONTRIBUTED',
      progressId: row.id,
      progressCount: row.progress_count,
      target: row.target,
      state: row.state,
      periodKey: row.period_key,
    };
  }

  const newCount = Math.min(progress.target, progress.progress_count + 1);
  const completed = newCount >= progress.target;
  let nextState: 'IN_PROGRESS' | 'COMPLETED';
  let startedAt: Date | null = progress.started_at;
  let completedAt: Date | null = progress.completed_at;

  if (progress.state === 'NOT_STARTED') {
    startedAt = input.occurredAt;
    if (completed) {
      nextState = 'COMPLETED';
      completedAt = input.occurredAt;
    } else {
      nextState = 'IN_PROGRESS';
    }
  } else {
    // IN_PROGRESS
    if (completed) {
      nextState = 'COMPLETED';
      completedAt = input.occurredAt;
      // Preserve existing started_at.
    } else {
      nextState = 'IN_PROGRESS';
    }
  }

  await client.query(
    `UPDATE mission_progress
     SET progress_count = $2,
         state = $3::task_progress_state,
         started_at = $4::timestamptz,
         completed_at = $5::timestamptz,
         updated_at = now()
     WHERE id = $1::uuid`,
    [
      progress.id,
      newCount,
      nextState,
      startedAt?.toISOString() ?? null,
      completedAt?.toISOString() ?? null,
    ],
  );

  if (nextState === 'COMPLETED' && progress.state !== 'COMPLETED') {
    await insertMissionOutboxEvent(client, {
      aggregateType: 'mission_progress',
      aggregateId: progress.id,
      eventType: 'mission.completed',
      dedupeKey: `mission-completed/${progress.id}`,
      payload: {
        progressId: progress.id,
        missionVersionId: version.id,
        userId: input.userId,
        periodKey: periodKey,
        completedAt: (completedAt ?? input.occurredAt).toISOString(),
      },
    });
  }

  return {
    outcome: 'CONTRIBUTED',
    progressId: progress.id,
    progressCount: newCount,
    target: progress.target,
    state: nextState,
    periodKey: periodKey,
    completed: nextState === 'COMPLETED',
  };
}

/** Convenience: load version without contribution (tests / callers). */
export async function loadMissionVersionForContribution(
  client: PoolClient,
  missionVersionId: string,
): Promise<MissionVersion> {
  return getMissionVersionById(client, missionVersionId);
}
