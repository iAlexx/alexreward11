/**
 * Mission reward issuance + MISSION maturity maintenance batches.
 * Post-grant AD reversal cascade: OWNER_POLICY_REQUIRED (not implemented).
 */
import type { Pool } from 'pg';

import { RewardDomainError } from './errors.js';
import {
  issueMissionReward,
  type IssueMissionRewardResult,
} from './issue-mission.js';
import { matureRewardEvent } from './maturity.js';
import type { EnvironmentName, MatureRewardEventResult } from './types.js';

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RewardDomainError('VALIDATION', 'limit must be a positive integer', {
      details: { limit },
    });
  }
  return Math.min(limit, 500);
}

export interface ProcessPendingMissionRewardClaimsBatchOptions {
  readonly environment: EnvironmentName;
  readonly limit: number;
}

export type MissionIssuanceBatchItem =
  | {
      readonly missionClaimId: string;
      readonly ok: true;
      readonly result: IssueMissionRewardResult;
    }
  | {
      readonly missionClaimId: string;
      readonly ok: false;
      readonly retriable: boolean;
      readonly reasonCode: string;
      readonly message: string;
    };

export interface ProcessPendingMissionRewardClaimsBatchResult {
  readonly scanned: number;
  readonly items: readonly MissionIssuanceBatchItem[];
}

/**
 * Select PENDING monetary mission claims and attempt issueMissionReward.
 * Unexpected errors remain retriable (no fake terminal rejection).
 */
export async function processPendingMissionRewardClaimsBatch(
  pool: Pool,
  options: ProcessPendingMissionRewardClaimsBatchOptions,
  deps: {
    readonly issueMissionReward?: typeof issueMissionReward;
  } = {},
): Promise<ProcessPendingMissionRewardClaimsBatchResult> {
  const limit = clampLimit(options.limit);
  const issue = deps.issueMissionReward ?? issueMissionReward;

  const selected = await pool.query<{ id: string }>(
    `SELECT mc.id
     FROM mission_claims mc
     INNER JOIN mission_versions mv ON mv.id = mc.mission_version_id
     WHERE mc.status = 'PENDING'::mission_claim_status
       AND mv.reward_rule_id IS NOT NULL
     ORDER BY mc.claimed_at ASC, mc.id ASC
     LIMIT $1`,
    [limit],
  );

  const items: MissionIssuanceBatchItem[] = [];
  for (const row of selected.rows) {
    try {
      const result = await issue(pool, {
        missionClaimId: row.id,
        environment: options.environment,
        idempotencyKey: `mission-issuance-batch/${row.id}`,
      });
      items.push({ missionClaimId: row.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'issuance failed';
      const reasonCode =
        error instanceof RewardDomainError ? error.code : 'MISSION_ISSUANCE_FAILED';
      items.push({
        missionClaimId: row.id,
        ok: false,
        retriable: true,
        reasonCode,
        message,
      });
    }
  }

  return { scanned: selected.rows.length, items };
}

export interface ProcessDueMissionRewardMaturityBatchOptions {
  readonly limit: number;
  readonly asOf?: Date;
}

export type MissionMaturityBatchItem =
  | {
      readonly rewardEventId: string;
      readonly ok: true;
      readonly result: MatureRewardEventResult;
    }
  | {
      readonly rewardEventId: string;
      readonly ok: false;
      readonly retriable: boolean;
      readonly reasonCode: string;
      readonly message: string;
    };

export interface ProcessDueMissionRewardMaturityBatchResult {
  readonly scanned: number;
  readonly items: readonly MissionMaturityBatchItem[];
}

export async function processDueMissionRewardMaturityBatch(
  pool: Pool,
  options: ProcessDueMissionRewardMaturityBatchOptions,
): Promise<ProcessDueMissionRewardMaturityBatchResult> {
  const limit = clampLimit(options.limit);
  const asOf = options.asOf ?? new Date();

  const selected = await pool.query<{ id: string }>(
    `SELECT re.id
     FROM reward_events re
     JOIN reward_maturities rm ON rm.reward_event_id = re.id
     WHERE re.source_type = 'MISSION'::reward_source_type
       AND re.state = 'PENDING'::reward_event_state
       AND rm.status = 'SCHEDULED'
       AND rm.scheduled_for <= $1::timestamptz
     ORDER BY rm.scheduled_for ASC, re.id ASC
     LIMIT $2`,
    [asOf.toISOString(), limit],
  );

  const items: MissionMaturityBatchItem[] = [];
  for (const row of selected.rows) {
    try {
      const result = await matureRewardEvent(pool, {
        rewardEventId: row.id,
        asOf,
        idempotencyKey: `mission-maturity-batch/${row.id}`,
      });
      items.push({ rewardEventId: row.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'maturity failed';
      const reasonCode =
        error instanceof RewardDomainError ? error.code : 'MISSION_MATURITY_FAILED';
      const retriable =
        !(error instanceof RewardDomainError) ||
        error.code === 'MATURITY_NOT_DUE' ||
        error.code === 'INTERNAL' ||
        error.code === 'VALIDATION';
      items.push({
        rewardEventId: row.id,
        ok: false,
        retriable,
        reasonCode,
        message,
      });
    }
  }

  return { scanned: selected.rows.length, items };
}
