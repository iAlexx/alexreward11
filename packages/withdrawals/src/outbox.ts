export {
  insertWithdrawalOutboxEvent,
  insertWithdrawalAuditLog,
  type InsertOutboxEventInput,
} from './audit.js';

export const WITHDRAWAL_APPROVED_OUTBOX_EVENT = 'withdrawal.approved' as const;

export function withdrawalApprovedDedupeKey(withdrawalId: string): string {
  return `withdrawal.approved:${withdrawalId}`;
}

export function withdrawalWorkflowId(withdrawalId: string): string {
  return `withdrawal/${withdrawalId}`;
}
