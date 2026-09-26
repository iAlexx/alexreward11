/**
 * Referral read models (Phase 12).
 *
 * The referral tables exist from the approved schema phase, but no approved engine writes
 * or activates them yet, so the summary reports `UNAVAILABLE` / `ENGINE_NOT_ENABLED`.
 * Counts are never estimated and no referral amount is ever quoted here.
 */

import type { DomainReasonCode, ServerDomainAvailability } from './common.js';

export interface ReferralsSummaryData {
  readonly referralCode: string | null;
  readonly invitedCount: number;
  readonly activatedCount: number;
}

export interface ReferralsSummaryResponse {
  readonly status: ServerDomainAvailability;
  readonly data: ReferralsSummaryData | null;
  readonly reasonCode?: DomainReasonCode;
}
