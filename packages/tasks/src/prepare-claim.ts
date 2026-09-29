/**
 * Phase 16 Step 4 — secure mission claim preparation / eligibility authority.
 * No money movement. packages/tasks must not import rewards or ledger.
 */
import type { Pool, PoolClient } from 'pg';

import {
  evaluateAndPersistEligibility,
  type DeploymentEnvironment,
} from '@alex-rewards/fraud';

import { MissionDomainError } from './errors.js';
import {
  mapMissionDefinitionRow,
  mapMissionVersionRow,
  type MissionDefinition,
  type MissionVersion,
} from './mission-version.js';
import { parseMissionEligibilityPolicy } from './eligibility-policy.js';

export type PrepareMissionClaimOutcome =
  | 'CLAIM_PENDING'
  | 'CLAIM_GRANTED'
  | 'ALREADY_GRANTED'
  | 'ALREADY_REJECTED'
  | 'NOT_ELIGIBLE';

export interface PrepareMissionClaimInput {
  readonly userId: string;
  readonly missionProgressId: string;
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly asOf?: Date;
}

export interface PrepareMissionClaimResult {
  readonly outcome: PrepareMissionClaimOutcome;
  readonly missionProgressId: string;
  readonly missionVersionId: string;
  readonly periodKey: string;
  readonly claimId: string | null;
  readonly claimStatus: 'PENDING' | 'GRANTED' | 'REJECTED' | null;
  readonly monetary: boolean;
  readonly recovered: boolean;
  readonly eligibilityDecisionId: string | null;
  readonly reasonCodes: readonly string[];
}

type Db = Pool | PoolClient;

interface ProgressLockRow {
  readonly id: string;
  readonly mission_version_id: string;
  readonly user_id: string;
  readonly period_key: string;
  readonly progress_count: number;
  readonly target: number;
  readonly state: string;
}

interface ClaimRow {
  readonly id: string;
  readonly status: string;
  readonly rejection_reason: string | null;
  readonly reward_event_id: string | null;
}

function isPoolClient(db: Db): db is PoolClient {
  return typeof (db as PoolClient).release === 'function' && !('totalCount' in db);
}

async function withOwnTransaction<T>(
  db: Db,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (isPoolClient(db)) {
    return fn(db);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }
}

function softResult(
  partial: Omit<PrepareMissionClaimResult, 'reasonCodes'> & {
    readonly reasonCodes?: readonly string[];
  },
): PrepareMissionClaimResult {
  return {
    ...partial,
    reasonCodes: partial.reasonCodes ?? [],
  };
}

async function lockUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`,
    [userId],
  );
  if (result.rows[0] === undefined) {
    throw new MissionDomainError('MISSION_PROGRESS_NOT_FOUND', 'mission progress not found', {
      userId,
    });
  }
}

async function probeProgress(
  client: PoolClient,
  missionProgressId: string,
): Promise<{ missionVersionId: string; userId: string; missionDefinitionId: string }> {
  const result = await client.query<{
    mission_version_id: string;
    user_id: string;
    mission_definition_id: string;
  }>(
    `SELECT mp.mission_version_id, mp.user_id, mv.mission_definition_id
     FROM mission_progress mp
     JOIN mission_versions mv ON mv.id = mp.mission_version_id
     WHERE mp.id = $1::uuid`,
    [missionProgressId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MissionDomainError('MISSION_PROGRESS_NOT_FOUND', 'mission progress not found', {
      missionProgressId,
    });
  }
  return {
    missionVersionId: row.mission_version_id,
    userId: row.user_id,
    missionDefinitionId: row.mission_definition_id,
  };
}

async function lockDefinition(
  client: PoolClient,
  missionDefinitionId: string,
): Promise<MissionDefinition> {
  const result = await client.query<{
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
    [missionDefinitionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MissionDomainError(
      'MISSION_NOT_CONFIGURED',
      `mission definition ${missionDefinitionId} not found`,
      { missionDefinitionId },
    );
  }
  return mapMissionDefinitionRow(row);
}

async function lockVersion(client: PoolClient, missionVersionId: string): Promise<MissionVersion> {
  const result = await client.query(
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

async function lockProgress(
  client: PoolClient,
  missionProgressId: string,
): Promise<ProgressLockRow> {
  const result = await client.query<ProgressLockRow>(
    `SELECT id, mission_version_id, user_id, period_key,
            progress_count, target, state::text AS state
     FROM mission_progress
     WHERE id = $1::uuid
     FOR UPDATE`,
    [missionProgressId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MissionDomainError('MISSION_PROGRESS_NOT_FOUND', 'mission progress not found', {
      missionProgressId,
    });
  }
  return row;
}

async function lockExistingClaim(
  client: PoolClient,
  input: {
    readonly missionVersionId: string;
    readonly userId: string;
    readonly periodKey: string;
  },
): Promise<ClaimRow | null> {
  const result = await client.query<ClaimRow>(
    `SELECT id, status::text AS status, rejection_reason, reward_event_id
     FROM mission_claims
     WHERE mission_version_id = $1::uuid
       AND user_id = $2::uuid
       AND period_key = $3
     FOR UPDATE`,
    [input.missionVersionId, input.userId, input.periodKey],
  );
  return result.rows[0] ?? null;
}

function assertClaimWindowOpen(version: MissionVersion, asOf: Date): void {
  if (version.startAt !== null && asOf < version.startAt) {
    throw new MissionDomainError(
      'MISSION_CLAIM_WINDOW_CLOSED',
      'mission claim window is not yet open',
      {
        missionVersionId: version.id,
        asOf: asOf.toISOString(),
        startAt: version.startAt.toISOString(),
      },
    );
  }
  if (version.endAt !== null && !(asOf < version.endAt)) {
    throw new MissionDomainError(
      'MISSION_CLAIM_WINDOW_CLOSED',
      'mission claim window is closed',
      {
        missionVersionId: version.id,
        asOf: asOf.toISOString(),
        endAt: version.endAt.toISOString(),
      },
    );
  }
}

async function assertValidAdEvidence(
  client: PoolClient,
  input: {
    readonly progress: ProgressLockRow;
    readonly version: MissionVersion;
  },
): Promise<void> {
  if (input.version.conditionType !== 'VALID_AD_COUNT') {
    return;
  }

  const valid = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM mission_progress_events mpe
     INNER JOIN reward_events re ON re.id = mpe.source_key::uuid
     WHERE mpe.mission_progress_id = $1::uuid
       AND mpe.source_kind = 'REWARD_EVENT'
       AND re.source_type = 'AD'
       AND re.state = 'AVAILABLE'`,
    [input.progress.id],
  );
  const count = valid.rows[0]?.c ?? 0;
  if (count < input.progress.target) {
    throw new MissionDomainError(
      'MISSION_SOURCE_EVIDENCE_NO_LONGER_VALID',
      'VALID_AD_COUNT claim evidence no longer meets target (reversed or unavailable ads)',
      {
        missionProgressId: input.progress.id,
        validAvailableCount: count,
        target: input.progress.target,
      },
    );
  }
}

/**
 * Prepare (or recover) a mission claim after server-verified completion.
 * Does not issue money. Monetary claims remain PENDING for Reward Engine.
 */
export async function prepareMissionClaim(
  db: Db,
  input: PrepareMissionClaimInput,
): Promise<PrepareMissionClaimResult> {
  if (input.userId.trim() === '' || input.missionProgressId.trim() === '') {
    throw new MissionDomainError('MISSION_INTEGRITY', 'userId and missionProgressId are required');
  }

  return withOwnTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();

    // 1. user FOR UPDATE
    await lockUser(client, input.userId);

    // Probe progress for lock targets (ownership checked after locks).
    const probe = await probeProgress(client, input.missionProgressId);
    if (probe.userId !== input.userId) {
      // Generalized not-found — do not leak another user's mission state.
      throw new MissionDomainError('MISSION_PROGRESS_NOT_FOUND', 'mission progress not found', {
        missionProgressId: input.missionProgressId,
      });
    }

    // 2. definition FOR SHARE
    const definition = await lockDefinition(client, probe.missionDefinitionId);

    // 3. version FOR SHARE
    const version = await lockVersion(client, probe.missionVersionId);
    // Touch typed eligibility parser early so invalid policy fails closed.
    parseMissionEligibilityPolicy(version.eligibilityPolicy);

    // 4. progress FOR UPDATE
    const progress = await lockProgress(client, input.missionProgressId);
    if (progress.user_id !== input.userId) {
      throw new MissionDomainError('MISSION_PROGRESS_NOT_FOUND', 'mission progress not found', {
        missionProgressId: input.missionProgressId,
      });
    }

    // 5. existing claim FOR UPDATE (if present)
    const existing = await lockExistingClaim(client, {
      missionVersionId: progress.mission_version_id,
      userId: progress.user_id,
      periodKey: progress.period_key,
    });

    const monetary = version.rewardRuleId !== null;
    const baseIds = {
      missionProgressId: progress.id,
      missionVersionId: progress.mission_version_id,
      periodKey: progress.period_key,
      monetary,
    };

    if (existing !== null) {
      if (existing.status === 'PENDING') {
        // Window may be closed; PENDING remains recoverable for Step 5 redrive.
        return softResult({
          outcome: 'CLAIM_PENDING',
          ...baseIds,
          claimId: existing.id,
          claimStatus: 'PENDING',
          recovered: true,
          eligibilityDecisionId: null,
          reasonCodes: ['CLAIM_PENDING_RECOVERED'],
        });
      }
      if (existing.status === 'GRANTED') {
        return softResult({
          outcome: 'ALREADY_GRANTED',
          ...baseIds,
          claimId: existing.id,
          claimStatus: 'GRANTED',
          recovered: true,
          eligibilityDecisionId: null,
          reasonCodes: ['CLAIM_ALREADY_GRANTED'],
        });
      }
      if (existing.status === 'REJECTED') {
        return softResult({
          outcome: 'ALREADY_REJECTED',
          ...baseIds,
          claimId: existing.id,
          claimStatus: 'REJECTED',
          recovered: true,
          eligibilityDecisionId: null,
          reasonCodes: [existing.rejection_reason ?? 'CLAIM_REJECTED'],
        });
      }
      throw new MissionDomainError(
        'MISSION_INTEGRITY',
        `unexpected mission claim status ${existing.status}`,
        { claimId: existing.id, status: existing.status },
      );
    }

    // --- NEW claim path ---
    if (definition.status !== 'ACTIVE') {
      throw new MissionDomainError(
        'MISSION_NOT_ACTIVE',
        `mission definition status is ${definition.status}; new claims require ACTIVE`,
        { missionDefinitionId: definition.id, status: definition.status },
      );
    }

    assertClaimWindowOpen(version, asOf);

    if (progress.state !== 'COMPLETED' || progress.progress_count !== progress.target) {
      throw new MissionDomainError(
        'MISSION_NOT_COMPLETED',
        'mission progress is not completed; cannot claim',
        {
          missionProgressId: progress.id,
          state: progress.state,
          progressCount: progress.progress_count,
          target: progress.target,
        },
      );
    }

    await assertValidAdEvidence(client, { progress, version });

    const eligibility = await evaluateAndPersistEligibility(client, {
      userId: input.userId,
      actionType: 'MISSION_CLAIM',
      serverContext: { deploymentEnvironment: input.deploymentEnvironment },
      missionVersionId: version.id,
    });

    if (eligibility.evaluation.outcome !== 'ELIGIBLE') {
      // Prefer no claim row for ordinary current ineligibility; decision is evidence.
      return softResult({
        outcome: 'NOT_ELIGIBLE',
        ...baseIds,
        claimId: null,
        claimStatus: null,
        recovered: false,
        eligibilityDecisionId: eligibility.decision.id,
        reasonCodes: eligibility.evaluation.reasonCodes,
      });
    }

    if (monetary) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mission_claims (
           mission_version_id, mission_progress_id, user_id, period_key,
           status, claimed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4,
           'PENDING'::mission_claim_status, $5::timestamptz
         )
         RETURNING id`,
        [
          progress.mission_version_id,
          progress.id,
          progress.user_id,
          progress.period_key,
          asOf.toISOString(),
        ],
      );
      const claimId = inserted.rows[0]?.id;
      if (claimId === undefined) {
        throw new MissionDomainError('INTERNAL', 'mission_claims insert failed');
      }
      return softResult({
        outcome: 'CLAIM_PENDING',
        ...baseIds,
        claimId,
        claimStatus: 'PENDING',
        recovered: false,
        eligibilityDecisionId: eligibility.decision.id,
        reasonCodes: ['CLAIM_PENDING_CREATED'],
      });
    }

    // Non-monetary: atomically GRANT after all checks.
    const granted = await client.query<{ id: string }>(
      `INSERT INTO mission_claims (
         mission_version_id, mission_progress_id, user_id, period_key,
         status, claimed_at, granted_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         'GRANTED'::mission_claim_status, $5::timestamptz, $5::timestamptz
       )
       RETURNING id`,
      [
        progress.mission_version_id,
        progress.id,
        progress.user_id,
        progress.period_key,
        asOf.toISOString(),
      ],
    );
    const claimId = granted.rows[0]?.id;
    if (claimId === undefined) {
      throw new MissionDomainError('INTERNAL', 'mission_claims insert failed');
    }
    return softResult({
      outcome: 'CLAIM_GRANTED',
      ...baseIds,
      claimId,
      claimStatus: 'GRANTED',
      recovered: false,
      eligibilityDecisionId: eligibility.decision.id,
      reasonCodes: ['CLAIM_GRANTED_NON_MONETARY'],
    });
  });
}
