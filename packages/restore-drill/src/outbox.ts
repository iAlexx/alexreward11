import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

export interface OutboxReconciliationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly pending: number;
  readonly processing: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly oldestPendingAgeSeconds: number | null;
  readonly withdrawalApprovedPending: number;
  readonly lagThreshold: 'THRESHOLD_NOT_CONFIGURED';
}

export async function reconcileOutboxReadOnly(pool: Pool): Promise<OutboxReconciliationResult> {
  try {
    const counts = await pool.query<{
      pending: string;
      dispatched: string;
      failed: string;
      oldest_pending_age_seconds: string | null;
      withdrawal_approved_pending: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'DISPATCHED')::text AS dispatched,
         COUNT(*) FILTER (WHERE status IN ('FAILED', 'DEAD_LETTER'))::text AS failed,
         COALESCE(
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::bigint,
           NULL
         )::text AS oldest_pending_age_seconds,
         COUNT(*) FILTER (
           WHERE status = 'PENDING' AND event_type = 'withdrawal.approved'
         )::text AS withdrawal_approved_pending
       FROM outbox_events`,
    );
    const pending = Number(counts.rows[0]?.pending ?? 0);
    const processing = 0; // No PROCESSING status in outbox_event_status enum.
    const dispatched = Number(counts.rows[0]?.dispatched ?? 0);
    const failed = Number(counts.rows[0]?.failed ?? 0);
    const oldestRaw = counts.rows[0]?.oldest_pending_age_seconds;
    const oldestPendingAgeSeconds = oldestRaw === null || oldestRaw === undefined ? null : Number(oldestRaw);
    const withdrawalApprovedPending = Number(counts.rows[0]?.withdrawal_approved_pending ?? 0);

    // No Owner lag threshold — observe only; pending work does not invent DANGER severity alone.
    const status: DrillSectionStatus =
      pending > 0 || processing > 0 || failed > 0 ? 'THRESHOLD_NOT_CONFIGURED' : 'PASS';
    return {
      status,
      reasonCode:
        status === 'PASS' ? 'OUTBOX_OBSERVED_CLEAN' : 'OUTBOX_OBSERVED_PENDING_OR_FAILED',
      pending,
      processing,
      dispatched,
      failed,
      oldestPendingAgeSeconds,
      withdrawalApprovedPending,
      lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
    };
  } catch {
    return {
      status: 'FAIL',
      reasonCode: 'OUTBOX_QUERY_FAILED',
      pending: 0,
      processing: 0,
      dispatched: 0,
      failed: 0,
      oldestPendingAgeSeconds: null,
      withdrawalApprovedPending: 0,
      lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
    };
  }
}
