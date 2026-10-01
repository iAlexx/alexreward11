import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

export interface OutboxReconciliationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly pending: number;
  readonly processing: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly deadLetter: number;
  readonly oldestPendingAgeSeconds: number | null;
  readonly withdrawalApprovedPending: number;
  readonly duplicateDedupeKeyAnomalies: number;
  readonly lagThreshold: 'THRESHOLD_NOT_CONFIGURED';
}

export async function reconcileOutboxReadOnly(pool: Pool): Promise<OutboxReconciliationResult> {
  try {
    const counts = await pool.query<{
      pending: string;
      dispatched: string;
      failed: string;
      dead_letter: string;
      oldest_pending_age_seconds: string | null;
      withdrawal_approved_pending: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'DISPATCHED')::text AS dispatched,
         COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
         COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::text AS dead_letter,
         COALESCE(
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::bigint,
           NULL
         )::text AS oldest_pending_age_seconds,
         COUNT(*) FILTER (
           WHERE status = 'PENDING' AND event_type = 'withdrawal.approved'
         )::text AS withdrawal_approved_pending
       FROM outbox_events`,
    );

    let duplicateDedupeKeyAnomalies = 0;
    try {
      const dupes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT dedupe_key
             FROM outbox_events
            WHERE dedupe_key IS NOT NULL
            GROUP BY dedupe_key
           HAVING COUNT(*) > 1
         ) d`,
      );
      duplicateDedupeKeyAnomalies = Number(dupes.rows[0]?.count ?? 0);
    } catch {
      return {
        status: 'FAIL',
        reasonCode: 'OUTBOX_DEDUPE_QUERY_FAILED',
        pending: 0,
        processing: 0,
        dispatched: 0,
        failed: 0,
        deadLetter: 0,
        oldestPendingAgeSeconds: null,
        withdrawalApprovedPending: 0,
        duplicateDedupeKeyAnomalies: 0,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      };
    }

    const pending = Number(counts.rows[0]?.pending ?? 0);
    const processing = 0; // No PROCESSING status in outbox_event_status enum.
    const dispatched = Number(counts.rows[0]?.dispatched ?? 0);
    const failed = Number(counts.rows[0]?.failed ?? 0);
    const deadLetter = Number(counts.rows[0]?.dead_letter ?? 0);
    const oldestRaw = counts.rows[0]?.oldest_pending_age_seconds;
    const oldestPendingAgeSeconds =
      oldestRaw === null || oldestRaw === undefined ? null : Number(oldestRaw);
    const withdrawalApprovedPending = Number(counts.rows[0]?.withdrawal_approved_pending ?? 0);

    if (duplicateDedupeKeyAnomalies > 0) {
      return {
        status: 'FAIL',
        reasonCode: 'OUTBOX_DUPLICATE_DEDUPE_KEYS',
        pending,
        processing,
        dispatched,
        failed,
        deadLetter,
        oldestPendingAgeSeconds,
        withdrawalApprovedPending,
        duplicateDedupeKeyAnomalies,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      };
    }

    if (failed > 0 || deadLetter > 0) {
      return {
        status: 'OWNER_REVIEW_REQUIRED',
        reasonCode: 'OUTBOX_FAILED_OR_DEAD_LETTER',
        pending,
        processing,
        dispatched,
        failed,
        deadLetter,
        oldestPendingAgeSeconds,
        withdrawalApprovedPending,
        duplicateDedupeKeyAnomalies,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      };
    }

    if (withdrawalApprovedPending > 0) {
      return {
        status: 'OWNER_REVIEW_REQUIRED',
        reasonCode: 'OUTBOX_WITHDRAWAL_APPROVED_PENDING',
        pending,
        processing,
        dispatched,
        failed,
        deadLetter,
        oldestPendingAgeSeconds,
        withdrawalApprovedPending,
        duplicateDedupeKeyAnomalies,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      };
    }

    if (pending > 0 || processing > 0) {
      return {
        status: 'THRESHOLD_NOT_CONFIGURED',
        reasonCode: 'OUTBOX_GENERIC_PENDING_NO_THRESHOLD',
        pending,
        processing,
        dispatched,
        failed,
        deadLetter,
        oldestPendingAgeSeconds,
        withdrawalApprovedPending,
        duplicateDedupeKeyAnomalies,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      };
    }

    return {
      status: 'PASS',
      reasonCode: 'OUTBOX_OBSERVED_CLEAN',
      pending,
      processing,
      dispatched,
      failed,
      deadLetter,
      oldestPendingAgeSeconds,
      withdrawalApprovedPending,
      duplicateDedupeKeyAnomalies,
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
      deadLetter: 0,
      oldestPendingAgeSeconds: null,
      withdrawalApprovedPending: 0,
      duplicateDedupeKeyAnomalies: 0,
      lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
    };
  }
}
