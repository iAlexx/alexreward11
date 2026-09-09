/**
 * Authoritative withdrawal state transitions (Phase 7).
 * AUTO-PAYOUT is NOT enabled — RISK_CHECK never goes directly to APPROVED.
 */
export type WithdrawalState =
  | 'REQUESTED'
  | 'RISK_CHECK'
  | 'MANUAL_REVIEW'
  | 'APPROVED'
  | 'QUEUED'
  | 'SIGNING'
  | 'BROADCASTING'
  | 'BROADCASTED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'HELD'
  | 'FAILED_PRE_BROADCAST'
  | 'RECONCILE_REQUIRED'
  | 'REJECTED';

const ALLOWED: ReadonlyMap<WithdrawalState, ReadonlySet<WithdrawalState>> = new Map([
  ['REQUESTED', new Set(['RISK_CHECK'])],
  ['RISK_CHECK', new Set(['MANUAL_REVIEW', 'HELD', 'REJECTED'])],
  ['MANUAL_REVIEW', new Set(['APPROVED', 'HELD', 'REJECTED'])],
  ['APPROVED', new Set(['QUEUED', 'HELD'])],
  ['HELD', new Set(['MANUAL_REVIEW', 'APPROVED', 'REJECTED', 'RECONCILE_REQUIRED'])],
  ['QUEUED', new Set(['SIGNING', 'HELD'])],
  ['SIGNING', new Set(['BROADCASTING', 'FAILED_PRE_BROADCAST'])],
  ['FAILED_PRE_BROADCAST', new Set(['QUEUED', 'HELD', 'REJECTED'])],
  ['BROADCASTING', new Set(['BROADCASTED', 'RECONCILE_REQUIRED'])],
  ['BROADCASTED', new Set(['CONFIRMING', 'RECONCILE_REQUIRED'])],
  ['CONFIRMING', new Set(['CONFIRMED', 'RECONCILE_REQUIRED'])],
  ['RECONCILE_REQUIRED', new Set(['CONFIRMED', 'QUEUED', 'HELD'])],
  ['CONFIRMED', new Set()],
  ['REJECTED', new Set()],
]);

export function isTerminalState(state: WithdrawalState): boolean {
  return state === 'CONFIRMED' || state === 'REJECTED';
}

export function assertTransitionAllowed(
  from: WithdrawalState,
  to: WithdrawalState,
  options?: { readonly heldFromReconcile?: boolean; readonly definitiveNonpayment?: boolean },
): void {
  const allowed = ALLOWED.get(from);
  if (allowed === undefined || !allowed.has(to)) {
    throw new Error(`TRANSITION_FORBIDDEN:${from}->${to}`);
  }
  // Reconcile-origin HELD cannot APPROVE/REJECT without definitive nonpayment proof for REJECT,
  // and cannot APPROVE until paid/non-paid resolved (Owner rule: no APPROVE/REJECT without proof).
  if (from === 'HELD' && options?.heldFromReconcile === true) {
    if (to === 'APPROVED') {
      throw new Error(
        'TRANSITION_FORBIDDEN:reconcile-origin HELD cannot APPROVE without resolution',
      );
    }
    if (to === 'REJECTED' && options.definitiveNonpayment !== true) {
      throw new Error(
        'TRANSITION_FORBIDDEN:reconcile-origin HELD cannot REJECT without nonpayment proof',
      );
    }
  }
  // BROADCASTING cannot go to REJECTED
  if (from === 'BROADCASTING' && to === 'REJECTED') {
    throw new Error('TRANSITION_FORBIDDEN:BROADCASTING->REJECTED');
  }
  if (from === 'RECONCILE_REQUIRED' && to === 'REJECTED') {
    throw new Error('TRANSITION_FORBIDDEN:RECONCILE_REQUIRED->REJECTED');
  }
}

export function workflowIdForWithdrawal(withdrawalId: string): string {
  return `withdrawal/${withdrawalId}`;
}
