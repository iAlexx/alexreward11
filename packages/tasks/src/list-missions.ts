/**
 * Phase 16 Step 6 — user-facing mission list projection (read-only).
 * No mutation. No fake rows. Reward amounts only from pinned MISSION rules.
 */
import type { Pool, PoolClient } from 'pg';

import { parseMissionEligibilityPolicy } from './eligibility-policy.js';
import { resolveMissionPeriod } from './period.js';
import { mapMissionVersionRow, type MissionResetPolicy } from './mission-version.js';

export interface UserMissionListItem {
  readonly taskCode: string;
  readonly missionVersionId: string;
  readonly progressId: string | null;
  readonly nameKey: string;
  readonly descriptionKey: string | null;
  readonly state: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED';
  readonly progressCount: number;
  readonly target: number;
  readonly resetPolicy: MissionResetPolicy;
  readonly periodKey: string;
  readonly claimStatus: 'PENDING' | 'GRANTED' | 'REJECTED' | null;
  readonly claimable: boolean;
  readonly rewardAtomic: string | null;
  readonly endsAt: string | null;
}

type Db = Pool | PoolClient;

/**
 * Project ACTIVE mission versions applicable at server now for one user.
 * Does not insert progress rows.
 */
export async function listUserMissions(
  db: Db,
  input: { readonly userId: string; readonly asOf?: Date },
): Promise<readonly UserMissionListItem[]> {
  const asOf = input.asOf ?? new Date();
  const versions = await db.query<{
    id: string;
    mission_definition_id: string;
    mission_version: number;
    name_key: string;
    description_key: string | null;
    condition_type: string;
    target: number;
    reset_policy: string;
    eligibility_policy: unknown;
    required_membership_plan_id: string | null;
    reward_source_type: string;
    reward_rule_id: string | null;
    status: string;
    start_at: Date | null;
    end_at: Date | null;
    created_at: Date;
    code: string;
    fixed_reward_atomic: string | null;
  }>(
    `SELECT mv.id, mv.mission_definition_id, mv.mission_version,
            mv.name_key, mv.description_key, mv.condition_type::text AS condition_type,
            mv.target, mv.reset_policy::text AS reset_policy, mv.eligibility_policy,
            mv.required_membership_plan_id, mv.reward_source_type::text AS reward_source_type,
            mv.reward_rule_id, mv.status::text AS status, mv.start_at, mv.end_at, mv.created_at,
            md.code,
            rr.fixed_reward_atomic::text AS fixed_reward_atomic
     FROM mission_versions mv
     INNER JOIN mission_definitions md ON md.id = mv.mission_definition_id
     LEFT JOIN reward_rules rr
       ON rr.id = mv.reward_rule_id
      AND rr.source_type = 'MISSION'
     WHERE md.status = 'ACTIVE'
       AND mv.status = 'ACTIVE'
       AND (mv.start_at IS NULL OR mv.start_at <= $1::timestamptz)
       AND (mv.end_at IS NULL OR mv.end_at > $1::timestamptz)
     ORDER BY md.code ASC, mv.mission_version ASC`,
    [asOf.toISOString()],
  );

  const items: UserMissionListItem[] = [];
  for (const row of versions.rows) {
    const version = mapMissionVersionRow(row);
    // Fail closed on invalid typed eligibility — skip projection rather than invent.
    try {
      parseMissionEligibilityPolicy(version.eligibilityPolicy);
    } catch {
      continue;
    }

    const period = resolveMissionPeriod(version.resetPolicy, asOf);
    const progress = await db.query<{
      id: string;
      progress_count: number;
      state: string;
    }>(
      `SELECT id, progress_count, state::text AS state
       FROM mission_progress
       WHERE mission_version_id = $1::uuid
         AND user_id = $2::uuid
         AND period_key = $3`,
      [version.id, input.userId, period.periodKey],
    );
    const prog = progress.rows[0];
    const progressId = prog?.id ?? null;
    const progressCount = prog?.progress_count ?? 0;
    const state = (prog?.state ?? 'NOT_STARTED') as UserMissionListItem['state'];

    let claimStatus: UserMissionListItem['claimStatus'] = null;
    if (progressId !== null) {
      const claim = await db.query<{ status: string }>(
        `SELECT status::text AS status
         FROM mission_claims
         WHERE mission_progress_id = $1::uuid
         LIMIT 1`,
        [progressId],
      );
      const status = claim.rows[0]?.status;
      if (status === 'PENDING' || status === 'GRANTED' || status === 'REJECTED') {
        claimStatus = status;
      }
    }

    const claimable =
      state === 'COMPLETED' &&
      (claimStatus === null || claimStatus === 'PENDING') &&
      progressId !== null;

    const rewardAtomic =
      version.rewardRuleId !== null && row.fixed_reward_atomic !== null
        ? row.fixed_reward_atomic
        : null;

    items.push({
      taskCode: row.code,
      missionVersionId: version.id,
      progressId,
      nameKey: version.nameKey,
      descriptionKey: version.descriptionKey,
      state,
      progressCount,
      target: version.target,
      resetPolicy: version.resetPolicy,
      periodKey: period.periodKey,
      claimStatus,
      claimable,
      rewardAtomic,
      endsAt: version.endAt?.toISOString() ?? null,
    });
  }

  return items;
}
