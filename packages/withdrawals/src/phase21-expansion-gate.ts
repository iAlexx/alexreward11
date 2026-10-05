/**
 * Phase 21 — zero-tolerance expansion gate (Spec §178).
 *
 * READY_FOR_POST_MICRO_LAUNCH_REVIEW is review-only.
 * Expansion is NEVER automatic after 50 confirmed withdrawals.
 */
import { PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS } from './phase21-config.js';

export type Phase21ExpansionGateVerdict =
  | 'READY_FOR_POST_MICRO_LAUNCH_REVIEW'
  | 'BLOCKED_INSUFFICIENT_CONFIRMED'
  | 'BLOCKED_DUPLICATE_PAYOUT'
  | 'BLOCKED_UNEXPLAINED_RECONCILIATION_DIFFERENCE'
  | 'BLOCKED_LEDGER_INVARIANT_VIOLATION';

export interface Phase21ExpansionGateInput {
  readonly confirmedRealWithdrawals: number;
  readonly duplicatePayoutCount: number;
  readonly unexplainedReconciliationDifferenceCount: number;
  readonly ledgerInvariantViolationCount: number;
}

export interface Phase21ExpansionGateResult {
  readonly verdict: Phase21ExpansionGateVerdict;
  readonly automaticExpansion: false;
  readonly ownerReviewRequired: true;
  readonly confirmedRealWithdrawals: number;
  readonly requiredConfirmed: typeof PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS;
  readonly duplicatePayoutCount: number;
  readonly unexplainedReconciliationDifferenceCount: number;
  readonly ledgerInvariantViolationCount: number;
  readonly reasons: readonly string[];
}

/**
 * Deterministic post-micro-launch review gate.
 * Never authorizes automatic limit/funding expansion.
 */
export function evaluatePhase21ExpansionGate(
  input: Phase21ExpansionGateInput,
): Phase21ExpansionGateResult {
  const confirmed = Number.isFinite(input.confirmedRealWithdrawals)
    ? Math.trunc(input.confirmedRealWithdrawals)
    : 0;
  const duplicates = Number.isFinite(input.duplicatePayoutCount)
    ? Math.trunc(input.duplicatePayoutCount)
    : 0;
  const unexplained = Number.isFinite(input.unexplainedReconciliationDifferenceCount)
    ? Math.trunc(input.unexplainedReconciliationDifferenceCount)
    : 0;
  const ledgerViolations = Number.isFinite(input.ledgerInvariantViolationCount)
    ? Math.trunc(input.ledgerInvariantViolationCount)
    : 0;

  const reasons: string[] = [];

  if (duplicates !== 0) {
    reasons.push(`duplicatePayoutCount=${duplicates} (must be 0)`);
    return {
      verdict: 'BLOCKED_DUPLICATE_PAYOUT',
      automaticExpansion: false,
      ownerReviewRequired: true,
      confirmedRealWithdrawals: confirmed,
      requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
      duplicatePayoutCount: duplicates,
      unexplainedReconciliationDifferenceCount: unexplained,
      ledgerInvariantViolationCount: ledgerViolations,
      reasons,
    };
  }

  if (unexplained !== 0) {
    reasons.push(
      `unexplainedReconciliationDifferenceCount=${unexplained} (must be 0)`,
    );
    return {
      verdict: 'BLOCKED_UNEXPLAINED_RECONCILIATION_DIFFERENCE',
      automaticExpansion: false,
      ownerReviewRequired: true,
      confirmedRealWithdrawals: confirmed,
      requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
      duplicatePayoutCount: duplicates,
      unexplainedReconciliationDifferenceCount: unexplained,
      ledgerInvariantViolationCount: ledgerViolations,
      reasons,
    };
  }

  if (ledgerViolations !== 0) {
    reasons.push(`ledgerInvariantViolationCount=${ledgerViolations} (must be 0)`);
    return {
      verdict: 'BLOCKED_LEDGER_INVARIANT_VIOLATION',
      automaticExpansion: false,
      ownerReviewRequired: true,
      confirmedRealWithdrawals: confirmed,
      requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
      duplicatePayoutCount: duplicates,
      unexplainedReconciliationDifferenceCount: unexplained,
      ledgerInvariantViolationCount: ledgerViolations,
      reasons,
    };
  }

  if (confirmed < PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS) {
    reasons.push(
      `confirmedRealWithdrawals=${confirmed} (need >= ${PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS})`,
    );
    return {
      verdict: 'BLOCKED_INSUFFICIENT_CONFIRMED',
      automaticExpansion: false,
      ownerReviewRequired: true,
      confirmedRealWithdrawals: confirmed,
      requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
      duplicatePayoutCount: duplicates,
      unexplainedReconciliationDifferenceCount: unexplained,
      ledgerInvariantViolationCount: ledgerViolations,
      reasons,
    };
  }

  return {
    verdict: 'READY_FOR_POST_MICRO_LAUNCH_REVIEW',
    automaticExpansion: false,
    ownerReviewRequired: true,
    confirmedRealWithdrawals: confirmed,
    requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
    duplicatePayoutCount: duplicates,
    unexplainedReconciliationDifferenceCount: unexplained,
    ledgerInvariantViolationCount: ledgerViolations,
    reasons: [
      'Confirmed/reconciled/ledger-clean count met; Owner review required before any expansion. Expansion is never automatic.',
    ],
  };
}
