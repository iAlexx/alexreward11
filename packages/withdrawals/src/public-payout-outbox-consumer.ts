/**
 * Phase 17 Step 2 — withdrawal.confirmed outbox consumer -> publication builder.
 * No Telegram send.
 */

import type { Pool, PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import {
  claimPendingWithdrawalConfirmedEvents,
  markOutboxDispatched,
  markOutboxRetry,
} from './outbox-relay.js';
import {
  createConfirmedPayoutPublication,
} from './public-payout-builder.js';
import type { PublicPayoutFeatureEnvironment } from './public-payout-feature.js';

export interface ProcessWithdrawalConfirmedPublicPayoutOutboxBatchOptions {
  readonly environment: PublicPayoutFeatureEnvironment;
  readonly limit?: number;
}

export interface ProcessWithdrawalConfirmedPublicPayoutOutboxBatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly retried: number;
}

function parsePayloadIds(payload: Readonly<Record<string, unknown>>): {
  readonly withdrawalId: string;
  readonly confirmedAttemptId: string;
} {
  const withdrawalId =
    typeof payload.withdrawalId === 'string' ? payload.withdrawalId.trim() : '';
  const confirmedAttemptId =
    typeof payload.confirmedAttemptId === 'string'
      ? payload.confirmedAttemptId.trim()
      : '';
  if (withdrawalId === '' || confirmedAttemptId === '') {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'withdrawal.confirmed outbox payload missing withdrawalId/confirmedAttemptId',
    );
  }
  return { withdrawalId, confirmedAttemptId };
}

export async function processWithdrawalConfirmedPublicPayoutOutboxBatch(
  pool: Pool,
  options: ProcessWithdrawalConfirmedPublicPayoutOutboxBatchOptions,
): Promise<ProcessWithdrawalConfirmedPublicPayoutOutboxBatchResult> {
  const limit = options.limit ?? 20;
  const client: PoolClient = await pool.connect();
  let dispatched = 0;
  let retried = 0;
  try {
    await client.query('BEGIN');
    const events = await claimPendingWithdrawalConfirmedEvents(client, limit);
    const claimed = events.length;

    for (const event of events) {
      try {
        const { withdrawalId, confirmedAttemptId } = parsePayloadIds(event.payload);
        const result = await createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId,
          environment: options.environment,
        });
        if (
          result.outcome === 'FEATURE_DISABLED' ||
          result.outcome === 'FEATURE_MISSING' ||
          result.outcome === 'CREATED' ||
          result.outcome === 'EXISTING'
        ) {
          await markOutboxDispatched(client, event.id);
          dispatched += 1;
        } else {
          await markOutboxRetry(client, event.id, `unexpected_outcome:${String(result.outcome)}`);
          retried += 1;
        }
      } catch (error) {
        await markOutboxRetry(client, event.id, error);
        retried += 1;
      }
    }

    await client.query('COMMIT');
    return { claimed, dispatched, retried };
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
