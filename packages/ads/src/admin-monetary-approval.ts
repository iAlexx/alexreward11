/**
 * Phase 13 — refuse production monetary APPROVED when clarification register is open.
 *
 * AdsGram (and any provider) stays BLOCKED for money until clarifications are closed.
 * Admin cannot set production_monetary_status = APPROVED while open clarifications exist.
 */

import { AdsDomainError } from './errors.js';
import type { ProviderMonetaryStatus } from './types.js';

export interface RefuseProviderMonetaryApprovalInput {
  readonly providerCode: string;
  readonly targetStatus: ProviderMonetaryStatus;
  readonly openClarificationCount: number;
}

export interface RefuseProviderMonetaryApprovalResult {
  readonly allowed: boolean;
  readonly reasonCode: 'OPEN_CLARIFICATION_ITEMS' | null;
}

/**
 * Pure gate: APPROVED without a clear clarification register is refused.
 * Other target statuses (BLOCKED / TEST_ONLY / SUSPENDED) are not blocked here.
 */
export function refuseProviderMonetaryApprovalWithoutClarification(
  input: RefuseProviderMonetaryApprovalInput,
): RefuseProviderMonetaryApprovalResult {
  if (input.targetStatus === 'APPROVED' && input.openClarificationCount > 0) {
    return { allowed: false, reasonCode: 'OPEN_CLARIFICATION_ITEMS' };
  }
  return { allowed: true, reasonCode: null };
}

/**
 * Fail-closed assert used by Admin Ads APIs before any monetary-status mutation.
 */
export function assertProviderMonetaryApprovalAllowed(
  input: RefuseProviderMonetaryApprovalInput,
): void {
  const result = refuseProviderMonetaryApprovalWithoutClarification(input);
  if (!result.allowed) {
    throw new AdsDomainError(
      'CLARIFICATION_GATE_OPEN',
      'provider monetary APPROVED refused while clarification items remain open',
      {
        details: {
          reason: result.reasonCode,
          providerCode: input.providerCode,
          openClarificationCount: input.openClarificationCount,
        },
      },
    );
  }
}
