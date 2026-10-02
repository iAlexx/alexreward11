import { describe, expect, it } from 'vitest';

import { evaluatePhase21ExpansionGate } from '../src/phase21-expansion-gate.js';

describe('phase21 expansion gate', () => {
  it('blocks at 49 confirmed even when clean', () => {
    const result = evaluatePhase21ExpansionGate({
      confirmedRealWithdrawals: 49,
      duplicatePayoutCount: 0,
      unexplainedReconciliationDifferenceCount: 0,
      ledgerInvariantViolationCount: 0,
    });
    expect(result.verdict).toBe('BLOCKED_INSUFFICIENT_CONFIRMED');
    expect(result.automaticExpansion).toBe(false);
    expect(result.ownerReviewRequired).toBe(true);
  });

  it('passes review gate at 50 clean confirmed — never automatic expansion', () => {
    const result = evaluatePhase21ExpansionGate({
      confirmedRealWithdrawals: 50,
      duplicatePayoutCount: 0,
      unexplainedReconciliationDifferenceCount: 0,
      ledgerInvariantViolationCount: 0,
    });
    expect(result.verdict).toBe('READY_FOR_POST_MICRO_LAUNCH_REVIEW');
    expect(result.automaticExpansion).toBe(false);
    expect(result.ownerReviewRequired).toBe(true);
  });

  it('blocks on duplicate / unexplained mismatch / ledger violation regardless of count', () => {
    expect(
      evaluatePhase21ExpansionGate({
        confirmedRealWithdrawals: 50,
        duplicatePayoutCount: 1,
        unexplainedReconciliationDifferenceCount: 0,
        ledgerInvariantViolationCount: 0,
      }).verdict,
    ).toBe('BLOCKED_DUPLICATE_PAYOUT');

    expect(
      evaluatePhase21ExpansionGate({
        confirmedRealWithdrawals: 100,
        duplicatePayoutCount: 0,
        unexplainedReconciliationDifferenceCount: 1,
        ledgerInvariantViolationCount: 0,
      }).verdict,
    ).toBe('BLOCKED_UNEXPLAINED_RECONCILIATION_DIFFERENCE');

    expect(
      evaluatePhase21ExpansionGate({
        confirmedRealWithdrawals: 100,
        duplicatePayoutCount: 0,
        unexplainedReconciliationDifferenceCount: 0,
        ledgerInvariantViolationCount: 1,
      }).verdict,
    ).toBe('BLOCKED_LEDGER_INVARIANT_VIOLATION');
  });
});
