import { describe, expect, it } from 'vitest';

import {
  evaluatePhase21CanaryFailedPreZeroAttemptRecovery,
  isPhase21CanaryPriorWorkflowSafeToRestart,
  isPhase21CanaryWithdrawalStateAllowedForResume,
} from '../src/phase21-resume-canary-gates.js';

describe('phase21 resume canary gates', () => {
  it('allows APPROVED, QUEUED, and FAILED_PRE_BROADCAST withdrawal states', () => {
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('APPROVED')).toBe(true);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('QUEUED')).toBe(true);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('FAILED_PRE_BROADCAST')).toBe(true);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('CONFIRMED')).toBe(false);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('SIGNING')).toBe(false);
  });

  it('FAILED_PRE zero-attempt recovery requires ARMED + 0 attempts + no evidence + safe prior', () => {
    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'ARMED',
        attemptCount: 0,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }),
    ).toEqual({ eligible: true, reason: null });

    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'QUEUED',
        permitStatus: 'ARMED',
        attemptCount: 0,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }).reason,
    ).toBe('not_failed_pre_broadcast');

    expect(isPhase21CanaryPriorWorkflowSafeToRestart('COMPLETED')).toBe(true);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('RUNNING')).toBe(false);
  });
});
