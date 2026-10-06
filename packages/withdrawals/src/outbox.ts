export {
  insertWithdrawalOutboxEvent,
  insertWithdrawalAuditLog,
  type InsertOutboxEventInput,
} from './audit.js';

export const WITHDRAWAL_APPROVED_OUTBOX_EVENT = 'withdrawal.approved' as const;

export const WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT =
  'withdrawal.owner_review_required' as const;

/** Owner-gated redispatch after FAILED_PRE_BROADCAST (same withdrawal/{id}). */
export const WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT = 'withdrawal.failed_pre_retry' as const;

/** Phase 21 Owner-armed manual dispatch restart (same withdrawal/{id}, ALLOW_DUPLICATE). */
export const WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT =
  'withdrawal.phase21_manual_dispatch' as const;

export function withdrawalApprovedDedupeKey(withdrawalId: string): string {
  return `withdrawal.approved:${withdrawalId}`;
}

export function withdrawalOwnerReviewRequiredDedupeKey(
  withdrawalId: string,
  expectedState: 'MANUAL_REVIEW',
): string {
  return `withdrawal.owner_review_required:${withdrawalId}:${expectedState}`;
}

/**
 * Stable per retry-epoch dedupe key. Ordinal increments only when a prior
 * failed-pre-retry outbox for this withdrawal is no longer PENDING.
 */
export function withdrawalFailedPreRetryDedupeKey(
  withdrawalId: string,
  retryOrdinal: number,
): string {
  if (!Number.isInteger(retryOrdinal) || retryOrdinal < 1) {
    throw new Error('retryOrdinal must be a positive integer');
  }
  return `withdrawal.failed_pre_retry:${withdrawalId}:${retryOrdinal}`;
}

export function withdrawalPhase21ManualDispatchOutboxDedupeKey(
  withdrawalId: string,
  permitId: string,
): string {
  return `withdrawal.phase21_manual_dispatch:${withdrawalId}:${permitId}`;
}

export function withdrawalWorkflowId(withdrawalId: string): string {
  return `withdrawal/${withdrawalId}`;
}
