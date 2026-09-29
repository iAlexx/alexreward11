/**
 * Referral read models (Phase 15).
 *
 * Summary returns authoritative server counts. Referral codes are server-generated
 * via versioned policy; deep links are only returned when an approved public bot
 * username is configured (never hardcoded).
 */

import type { DomainReasonCode, ServerDomainAvailability } from './common.js';

export interface ReferralsSummaryData {
  readonly referralCode: string | null;
  /** Present only when server has an approved public bot username config. */
  readonly referralDeepLink: string | null;
  readonly invitedCount: number;
  readonly activatedCount: number;
}

export interface ReferralsSummaryResponse {
  readonly status: ServerDomainAvailability;
  readonly data: ReferralsSummaryData | null;
  readonly reasonCode?: DomainReasonCode;
}

export interface ReferralCodeResponse {
  readonly status: ServerDomainAvailability;
  readonly code: string | null;
  readonly deepLink: string | null;
  readonly reasonCode?: DomainReasonCode;
}
