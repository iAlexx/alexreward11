export {
  insertWithdrawalOutboxEvent,
  insertWithdrawalAuditLog,
  type InsertOutboxEventInput,
} from './audit.js';

export const WITHDRAWAL_APPROVED_OUTBOX_EVENT = 'withdrawal.approved' as const;

export const WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT =
  'withdrawal.owner_review_required' as const;

export function withdrawalApprovedDedupeKey(withdrawalId: string): string {
  return `withdrawal.approved:${withdrawalId}`;
}

export function withdrawalOwnerReviewRequiredDedupeKey(
  withdrawalId: string,
  expectedState: 'MANUAL_REVIEW',
): string {
  return `withdrawal.owner_review_required:${withdrawalId}:${expectedState}`;
}

export function withdrawalWorkflowId(withdrawalId: string): string {
  return `withdrawal/${withdrawalId}`;
}
