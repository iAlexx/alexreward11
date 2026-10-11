import { describe, expect, it } from 'vitest';

import {
  isPhase21CanaryPriorWorkflowSafeToRestart,
  isPhase21CanaryWithdrawalStateAllowedForResume,
} from '../src/phase21-resume-canary-gates.js';

describe('phase21 resume-canary preflight gates', () => {
  it('allows exact-canary withdrawal states APPROVED and QUEUED only', () => {
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('APPROVED')).toBe(true);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('QUEUED')).toBe(true);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('HELD')).toBe(false);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('BROADCASTED')).toBe(false);
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('CONFIRMED')).toBe(false);
  });

  it('allows closed Temporal statuses safe for ALLOW_DUPLICATE restart', () => {
    for (const status of [
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'CANCELED',
      'TERMINATED',
      'TIMED_OUT',
      '2',
      '3',
      '4',
      '5',
      '7',
    ]) {
      expect(isPhase21CanaryPriorWorkflowSafeToRestart(status)).toBe(true);
    }
  });

  it('refuses RUNNING and CONTINUED_AS_NEW (and numeric equivalents)', () => {
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('RUNNING')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('CONTINUED_AS_NEW')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('1')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('6')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('')).toBe(false);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('UNKNOWN')).toBe(false);
  });
});
