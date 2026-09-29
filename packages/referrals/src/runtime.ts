/**
 * Referral activation maintenance batch (no money movement).
 * packages/referrals must not import rewards/ledger/worker.
 */
import type { Pool, PoolClient } from 'pg';

import {
  evaluateReferralActivation,
  type ReferralActivationOutcome,
} from './activation.js';
import { ReferralDomainError } from './errors.js';

export interface ProcessPendingReferralActivationBatchOptions {
  readonly limit: number;
}

export type PendingReferralActivationBatchItem =
  | {
      readonly edgeId: string;
      readonly ok: true;
      readonly outcome: ReferralActivationOutcome;
    }
  | {
      readonly edgeId: string;
      readonly ok: false;
      readonly reasonCode: string;
      readonly message: string;
    };

export interface ProcessPendingReferralActivationBatchResult {
  readonly scanned: number;
  readonly items: readonly PendingReferralActivationBatchItem[];
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ReferralDomainError('INTERNAL', 'limit must be a positive integer', { limit });
  }
  return Math.min(limit, 500);
}

async function withOwnTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Select PENDING referral edges in stable order, evaluate each in an isolated
 * transaction, and continue after per-edge failures.
 *
 * When no ACTIVE referral rule is configured, report REFERRAL_RULE_NOT_CONFIGURED
 * and perform no edge mutations.
 */
export async function processPendingReferralActivationBatch(
  pool: Pool,
  options: ProcessPendingReferralActivationBatchOptions,
): Promise<ProcessPendingReferralActivationBatchResult> {
  const limit = clampLimit(options.limit);

  const selected = await pool.query<{ id: string }>(
    `SELECT id
     FROM referral_edges
     WHERE state = 'PENDING'::referral_edge_state
     ORDER BY attributed_at ASC, id ASC
     LIMIT $1`,
    [limit],
  );

  const items: PendingReferralActivationBatchItem[] = [];
  for (const row of selected.rows) {
    try {
      const outcome = await withOwnTransaction(pool, (client) =>
        evaluateReferralActivation(client, { edgeId: row.id }),
      );
      items.push({ edgeId: row.id, ok: true, outcome });
    } catch (error) {
      if (error instanceof ReferralDomainError && error.code === 'REFERRAL_RULE_NOT_CONFIGURED') {
        items.push({
          edgeId: row.id,
          ok: false,
          reasonCode: 'REFERRAL_RULE_NOT_CONFIGURED',
          message: error.message,
        });
        continue;
      }
      const message = error instanceof Error ? error.message : 'activation evaluation failed';
      const reasonCode =
        error instanceof ReferralDomainError ? error.code : 'ACTIVATION_EVALUATION_FAILED';
      items.push({
        edgeId: row.id,
        ok: false,
        reasonCode,
        message,
      });
    }
  }

  return { scanned: selected.rows.length, items };
}
