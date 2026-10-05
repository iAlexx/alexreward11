import type { PoolClient } from 'pg';

import { MissionDomainError } from './errors.js';

export type MissionDefinitionStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export type MissionVersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export type MissionConditionType =
  | 'DAILY_LOGIN'
  | 'VALID_AD_COUNT'
  | 'REFERRAL_ACTIVATION_COUNT'
  | 'STREAK_MILESTONE'
  | 'MEMBERSHIP_REQUIRED'
  | 'TIME_WINDOW'
  | 'COUNTRY_GROUP';

export type MissionResetPolicy = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface MissionDefinition {
  readonly id: string;
  readonly code: string;
  readonly nameKey: string;
  readonly status: MissionDefinitionStatus;
  readonly createdAt: Date;
}

export interface MissionVersion {
  readonly id: string;
  readonly missionDefinitionId: string;
  readonly missionVersion: number;
  readonly nameKey: string;
  readonly descriptionKey: string | null;
  readonly conditionType: MissionConditionType;
  readonly target: number;
  readonly resetPolicy: MissionResetPolicy;
  readonly eligibilityPolicy: unknown;
  readonly requiredMembershipPlanId: string | null;
  readonly rewardSourceType: string;
  readonly rewardRuleId: string | null;
  readonly status: MissionVersionStatus;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly createdAt: Date;
}

export type ResolvedMissionVersion = MissionVersion & {
  readonly status: 'ACTIVE';
};

interface MissionDefinitionRow {
  readonly id: string;
  readonly code: string;
  readonly name_key: string;
  readonly status: string;
  readonly created_at: Date;
}

interface MissionVersionRow {
  readonly id: string;
  readonly mission_definition_id: string;
  readonly mission_version: number;
  readonly name_key: string;
  readonly description_key: string | null;
  readonly condition_type: string;
  readonly target: number;
  readonly reset_policy: string;
  readonly eligibility_policy: unknown;
  readonly required_membership_plan_id: string | null;
  readonly reward_source_type: string;
  readonly reward_rule_id: string | null;
  readonly status: string;
  readonly start_at: Date | null;
  readonly end_at: Date | null;
  readonly created_at: Date;
}

const MISSION_VERSION_SELECT = `SELECT id, mission_definition_id, mission_version,
            name_key, description_key, condition_type::text AS condition_type,
            target, reset_policy::text AS reset_policy, eligibility_policy,
            required_membership_plan_id, reward_source_type::text AS reward_source_type,
            reward_rule_id, status::text AS status, start_at, end_at, created_at`;

const CONDITION_TYPES = new Set<string>([
  'DAILY_LOGIN',
  'VALID_AD_COUNT',
  'REFERRAL_ACTIVATION_COUNT',
  'STREAK_MILESTONE',
  'MEMBERSHIP_REQUIRED',
  'TIME_WINDOW',
  'COUNTRY_GROUP',
]);

const RESET_POLICIES = new Set<string>(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']);

function assertPositiveInt(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isNaN(value)) {
    throw new MissionDomainError('MISSION_INTEGRITY', `${label} must be an integer`, {
      label,
      value,
    });
  }
  if (value <= 0) {
    throw new MissionDomainError('MISSION_INTEGRITY', `${label} must be > 0`, {
      label,
      value,
    });
  }
  return value;
}

export function mapMissionDefinitionRow(row: MissionDefinitionRow): MissionDefinition {
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'PAUSED' &&
    row.status !== 'ARCHIVED'
  ) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      `invalid mission definition status ${row.status}`,
    );
  }
  return {
    id: row.id,
    code: row.code,
    nameKey: row.name_key,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function mapMissionVersionRow(row: MissionVersionRow): MissionVersion {
  if (
    row.status !== 'DRAFT' &&
    row.status !== 'ACTIVE' &&
    row.status !== 'SUPERSEDED' &&
    row.status !== 'REVOKED'
  ) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      `invalid mission version status ${row.status}`,
    );
  }
  if (!CONDITION_TYPES.has(row.condition_type)) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      `invalid mission condition_type ${row.condition_type}`,
    );
  }
  if (!RESET_POLICIES.has(row.reset_policy)) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      `invalid mission reset_policy ${row.reset_policy}`,
    );
  }
  return {
    id: row.id,
    missionDefinitionId: row.mission_definition_id,
    missionVersion: assertPositiveInt('mission_version', row.mission_version),
    nameKey: row.name_key,
    descriptionKey: row.description_key,
    conditionType: row.condition_type as MissionConditionType,
    target: assertPositiveInt('target', row.target),
    resetPolicy: row.reset_policy as MissionResetPolicy,
    eligibilityPolicy: row.eligibility_policy,
    requiredMembershipPlanId: row.required_membership_plan_id,
    rewardSourceType: row.reward_source_type,
    rewardRuleId: row.reward_rule_id,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    createdAt: row.created_at,
  };
}

export type ResolveActiveMissionVersionOptions = {
  readonly missionDefinitionId?: string;
  readonly code?: string;
  readonly at?: Date;
};

function assertExclusiveLookup(
  options: ResolveActiveMissionVersionOptions,
): void {
  if (options.missionDefinitionId !== undefined && options.code !== undefined) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      'provide missionDefinitionId or code, not both',
    );
  }
  if (
    options.missionDefinitionId === undefined &&
    (options.code === undefined || options.code === '')
  ) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      'missionDefinitionId or code is required',
    );
  }
}

/**
 * Load mission_definitions and require status = ACTIVE for authoritative resolution.
 * Missing → MISSION_NOT_CONFIGURED; present but inactive → MISSION_NOT_ACTIVE.
 */
async function resolveActiveDefinitionId(
  client: PoolClient,
  options: ResolveActiveMissionVersionOptions,
  forShare: boolean,
): Promise<string> {
  assertExclusiveLookup(options);

  const lockSql = forShare ? ' FOR SHARE' : '';
  let result: { rows: Array<{ id: string; status: string }> };

  if (options.missionDefinitionId !== undefined) {
    result = await client.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status
       FROM mission_definitions
       WHERE id = $1::uuid${lockSql}`,
      [options.missionDefinitionId],
    );
  } else {
    result = await client.query<{ id: string; status: string }>(
      `SELECT id, status::text AS status
       FROM mission_definitions
       WHERE code = $1${lockSql}`,
      [options.code],
    );
  }

  const row = result.rows[0];
  if (row === undefined) {
    throw new MissionDomainError(
      'MISSION_NOT_CONFIGURED',
      options.missionDefinitionId !== undefined
        ? `mission definition ${options.missionDefinitionId} not found`
        : `mission definition code ${options.code} not found`,
      {
        missionDefinitionId: options.missionDefinitionId,
        code: options.code,
      },
    );
  }

  if (row.status !== 'ACTIVE') {
    throw new MissionDomainError(
      'MISSION_NOT_ACTIVE',
      `mission definition status is ${row.status}, expected ACTIVE`,
      {
        missionDefinitionId: row.id,
        status: row.status,
      },
    );
  }

  return row.id;
}

function requireSingleActiveVersion(
  rows: MissionVersionRow[],
  definitionId: string,
  at: Date,
): ResolvedMissionVersion {
  if (rows.length === 0) {
    throw new MissionDomainError(
      'MISSION_NOT_CONFIGURED',
      'No ACTIVE mission version applies at the requested time',
      { missionDefinitionId: definitionId, at: at.toISOString() },
    );
  }
  if (rows.length > 1) {
    throw new MissionDomainError(
      'MISSION_VERSION_AMBIGUOUS',
      'Multiple ACTIVE mission versions apply at the same instant',
      {
        missionDefinitionId: definitionId,
        at: at.toISOString(),
        missionVersions: rows.map((row) => row.mission_version),
      },
    );
  }

  const mapped = mapMissionVersionRow(rows[0]!);
  if (mapped.status !== 'ACTIVE') {
    throw new MissionDomainError('MISSION_NOT_ACTIVE', 'Resolved mission version is not ACTIVE');
  }
  return mapped as ResolvedMissionVersion;
}

/**
 * Resolve the single ACTIVE mission version for an ACTIVE definition applicable at `at`.
 * Fail closed when zero or multiple rows match — never invent mission rules.
 * Read-only: does not acquire lifecycle locks.
 */
export async function resolveActiveMissionVersion(
  client: PoolClient,
  options: ResolveActiveMissionVersionOptions,
): Promise<ResolvedMissionVersion> {
  const definitionId = await resolveActiveDefinitionId(client, options, false);
  const at = options.at ?? new Date();
  const result = await client.query<MissionVersionRow>(
    `${MISSION_VERSION_SELECT}
     FROM mission_versions
     WHERE mission_definition_id = $1::uuid
       AND status = 'ACTIVE'
       AND (start_at IS NULL OR start_at <= $2::timestamptz)
       AND (end_at IS NULL OR $2::timestamptz < end_at)
     ORDER BY mission_version ASC`,
    [definitionId, at.toISOString()],
  );
  return requireSingleActiveVersion(result.rows, definitionId, at);
}

/**
 * Authoritative ACTIVE mission-version resolution for evaluation paths.
 * Lock order: mission_definitions FOR SHARE, then matching mission_versions FOR SHARE.
 * Uses server current time only (no caller `at`).
 */
export async function resolveActiveMissionVersionForEvaluation(
  client: PoolClient,
  options: { readonly missionDefinitionId?: string; readonly code?: string },
): Promise<ResolvedMissionVersion> {
  // 1) Lock definition lifecycle authority first (consistent order: definition → version).
  const definitionId = await resolveActiveDefinitionId(client, options, true);

  const nowResult = await client.query<{ now: Date }>(`SELECT now() AS now`);
  const at = nowResult.rows[0]?.now;
  if (at === undefined) {
    throw new MissionDomainError('INTERNAL', 'failed to read server now()');
  }

  // 2) Lock matching ACTIVE version row(s).
  const result = await client.query<MissionVersionRow>(
    `${MISSION_VERSION_SELECT}
     FROM mission_versions
     WHERE mission_definition_id = $1::uuid
       AND status = 'ACTIVE'
       AND (start_at IS NULL OR start_at <= $2::timestamptz)
       AND (end_at IS NULL OR $2::timestamptz < end_at)
     ORDER BY mission_version ASC
     FOR SHARE`,
    [definitionId, at.toISOString()],
  );
  return requireSingleActiveVersion(result.rows, definitionId, at);
}

/** Load a mission version by primary key (any status). */
export async function getMissionVersionById(
  client: PoolClient,
  missionVersionId: string,
): Promise<MissionVersion> {
  const result = await client.query<MissionVersionRow>(
    `${MISSION_VERSION_SELECT}
     FROM mission_versions
     WHERE id = $1::uuid`,
    [missionVersionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MissionDomainError(
      'MISSION_VERSION_NOT_FOUND',
      `mission version ${missionVersionId} not found`,
      { missionVersionId },
    );
  }
  return mapMissionVersionRow(row);
}
