/**
 * Referral issuance + REFERRAL maturity maintenance batches.
 * Isolated per-candidate; transient failures before durable decision are retriable.
 */
import type { Pool } from 'pg';

import { RewardDomainError } from './errors.js';
import {
  issueReferralReward,
  type IssueReferralRewardResult,
} from './issue-referral.js';
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

export interface ProcessReferralIssuanceBatchOptions {
  readonly environment: EnvironmentName;
  readonly limit: number;
}

export type ReferralIssuanceBatchItem =
  | {
      readonly sourceRewardEventId: string;
      readonly ok: true;
      readonly result: IssueReferralRewardResult;
    }
  | {
      readonly sourceRewardEventId: string;
      readonly ok: false;
      readonly retriable: boolean;
      readonly reasonCode: string;
      readonly message: string;
    };

export interface ProcessReferralIssuanceBatchResult {
  readonly scanned: number;
  readonly items: readonly ReferralIssuanceBatchItem[];
}

/**
 * Candidates: AVAILABLE AD rewards with ACTIVE edges, activated_at <= available_at,
 * and no referral_reward_decisions yet.
 * Does not select PENDING edges (so EDGE_NOT_ACTIVE is never written for them here).
 */
export async function processReferralIssuanceBatch(
  pool: Pool,
  options: ProcessReferralIssuanceBatchOptions,
  deps: {
    readonly issueReferralReward?: typeof issueReferralReward;
  } = {},
): Promise<ProcessReferralIssuanceBatchResult> {
  const limit = clampLimit(options.limit);
  const issue = deps.issueReferralReward ?? issueReferralReward;

  const selected = await pool.query<{ id: string }>(
    `SELECT re.id
     FROM reward_events re
     JOIN referral_edges edge
       ON edge.referred_user_id = re.user_id
      AND edge.state = 'ACTIVE'::referral_edge_state
      AND edge.activated_at IS NOT NULL
      AND edge.activated_at <= re.available_at
     WHERE re.source_type = 'AD'::reward_source_type
       AND re.state = 'AVAILABLE'::reward_event_state
       AND re.available_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM referral_reward_decisions d
         WHERE d.source_reward_event_id = re.id
       )
     ORDER BY re.available_at ASC, re.id ASC
     LIMIT $1`,
    [limit],
  );

  const items: ReferralIssuanceBatchItem[] = [];
  for (const row of selected.rows) {
    try {
      const result = await issue(pool, {
        sourceRewardEventId: row.id,
        environment: options.environment,
        idempotencyKey: `referral-issuance-batch/${row.id}`,
      });
      items.push({ sourceRewardEventId: row.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'issuance failed';
      const reasonCode =
        error instanceof RewardDomainError ? error.code : 'REFERRAL_ISSUANCE_FAILED';
      // No durable decision written → retriable on next cycle.
      items.push({
        sourceRewardEventId: row.id,
        ok: false,
        retriable: true,
        reasonCode,
        message,
      });
    }
  }

  return { scanned: selected.rows.length, items };
}

export interface ProcessDueReferralMaturityBatchOptions {
  readonly limit: number;
  readonly asOf?: Date;
}

export type ReferralMaturityBatchItem =
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

export interface ProcessDueReferralMaturityBatchResult {
  readonly scanned: number;
  readonly items: readonly ReferralMaturityBatchItem[];
}

/**
 * Mature due REFERRAL reward_events that still have SCHEDULED maturity rows.
 */
export async function processDueReferralMaturityBatch(
  pool: Pool,
  options: ProcessDueReferralMaturityBatchOptions,
): Promise<ProcessDueReferralMaturityBatchResult> {
  const limit = clampLimit(options.limit);
  const asOf = options.asOf ?? new Date();

  const selected = await pool.query<{ id: string }>(
    `SELECT re.id
     FROM reward_events re
     JOIN reward_maturities rm ON rm.reward_event_id = re.id
     WHERE re.source_type = 'REFERRAL'::reward_source_type
       AND re.state = 'PENDING'::reward_event_state
       AND rm.status = 'SCHEDULED'
       AND rm.scheduled_for <= $1::timestamptz
     ORDER BY rm.scheduled_for ASC, re.id ASC
     LIMIT $2`,
    [asOf.toISOString(), limit],
  );

  const items: ReferralMaturityBatchItem[] = [];
  for (const row of selected.rows) {
    try {
      const result = await matureRewardEvent(pool, {
        rewardEventId: row.id,
        asOf,
        idempotencyKey: `referral-maturity-batch/${row.id}`,
      });
      items.push({ rewardEventId: row.id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'maturity failed';
      const reasonCode =
        error instanceof RewardDomainError ? error.code : 'REFERRAL_MATURITY_FAILED';
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
