/**
 * Pure preflight gates for Phase 21 exact-canary (WD-000001) Temporal resume.
 * Code-only helpers - never dispatch, sign, or mutate production state.
 */

/**
 * Exact-canary withdrawal states that may resume with ALLOW_DUPLICATE restart.
 * FAILED_PRE_BROADCAST is eligible only when combined with ARMED permit,
 * zero attempts, no broadcast evidence, and a completed prior workflow
 * (see evaluatePhase21CanaryFailedPreZeroAttemptRecovery).
 */
export function isPhase21CanaryWithdrawalStateAllowedForResume(state: string): boolean {
  return (
    state === 'APPROVED' || state === 'QUEUED' || state === 'FAILED_PRE_BROADCAST'
  );
}

/**
 * Prior Temporal workflow statuses that are safe to restart with ALLOW_DUPLICATE.
 * Refuses RUNNING and CONTINUED_AS_NEW (numeric 1 / 6).
 */
export function isPhase21CanaryPriorWorkflowSafeToRestart(statusName: string): boolean {
  const s = statusName.trim().toUpperCase();
  if (s === '') return false;
  if (s === '1' || s === '6') return false;
  if (s.includes('RUNNING') || s.includes('CONTINUED_AS_NEW')) return false;

  if (s === '2' || s === '3' || s === '4' || s === '5' || s === '7') return true;
  if (
    s.includes('COMPLETED') ||
    s.includes('FAILED') ||
    s.includes('CANCELED') ||
    s.includes('CANCELLED') ||
    s.includes('TERMINATED') ||
    s.includes('TIMED_OUT')
  ) {
    return true;
  }
  return false;
}

/**
 * Owner-gated WD-000001 recovery from FAILED_PRE_BROADCAST with zero attempts.
 * Requires ARMED permit, no attempts, no broadcast evidence, and a prior
 * Temporal workflow status that is safe to restart (typically COMPLETED).
 * Does not mutate state - callers (resume CLI / disposable tests) enforce ACK.
 */
export function evaluatePhase21CanaryFailedPreZeroAttemptRecovery(input: {
  readonly withdrawalState: string;
  readonly permitStatus: string;
  readonly attemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly priorWorkflowStatus: string;
}): {
  readonly eligible: boolean;
  readonly reason: string | null;
} {
  if (input.withdrawalState !== 'FAILED_PRE_BROADCAST') {
    return { eligible: false, reason: 'not_failed_pre_broadcast' };
  }
  if (!isPhase21CanaryWithdrawalStateAllowedForResume(input.withdrawalState)) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (input.permitStatus !== 'ARMED') {
    return { eligible: false, reason: 'permit_not_armed' };
  }
  if (input.attemptCount !== 0) {
    return { eligible: false, reason: 'attempts_exist' };
  }
  if (input.broadcastEvidenceCount !== 0) {
    return { eligible: false, reason: 'broadcast_evidence_exists' };
  }
  if (!isPhase21CanaryPriorWorkflowSafeToRestart(input.priorWorkflowStatus)) {
    return { eligible: false, reason: 'prior_workflow_not_safe' };
  }
  return { eligible: true, reason: null };
}
