/**
 * Pure preflight gates for Phase 21 exact-canary (WD-000001) Temporal resume.
 * Code-only helpers - never dispatch, sign, or mutate production state.
 */

/** Exact-canary withdrawal states that may resume with ALLOW_DUPLICATE restart. */
export function isPhase21CanaryWithdrawalStateAllowedForResume(state: string): boolean {
  return state === 'APPROVED' || state === 'QUEUED';
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
