/**
 * Home screen aggregate read model (Phase 12).
 *
 * Every domain is independently statused. One failing or not-yet-enabled domain degrades
 * only its own slot: the home response still returns 200 with the domains that could be
 * read honestly, so a missions engine that does not exist can never blank out a balance.
 */

import type { UserBalancesResponse } from './balances.js';
import type { DomainEnvelope } from './common.js';
import type { EarnUsageBasisDto } from './earn.js';
import type { ReferralsSummaryData } from './referrals.js';

export interface HomeTodayAdsData {
  readonly utcDay: string;
  readonly providerCode: string;
  readonly monetaryEligible: boolean;
  readonly successRemaining: number | null;
  readonly requestRemaining: number | null;
  readonly requestUsageBasis: EarnUsageBasisDto;
  readonly successUsageBasis: EarnUsageBasisDto;
}

export interface HomeMissionsData {
  readonly activeCount: number;
  readonly claimableCount: number;
}

export interface HomeLatestWithdrawalData {
  readonly id: string;
  readonly publicId: string;
  readonly state: string;
  readonly netAmountAtomic: string;
  readonly requestedAt: string;
}

export interface HomeAnnouncementData {
  readonly id: string;
  readonly typeCode: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface HomeMembershipBriefData {
  readonly active: boolean;
  readonly planCode: string | null;
  readonly isFounder: boolean;
  readonly founderNumber: number | null;
}

export interface HomeSummaryResponse {
  readonly asOf: string;
  readonly balances: DomainEnvelope<UserBalancesResponse>;
  readonly todayAds: DomainEnvelope<HomeTodayAdsData>;
  readonly missions: DomainEnvelope<HomeMissionsData>;
  readonly referrals: DomainEnvelope<ReferralsSummaryData>;
  readonly latestWithdrawal: DomainEnvelope<HomeLatestWithdrawalData>;
  readonly announcement: DomainEnvelope<HomeAnnouncementData>;
  readonly membershipBrief: DomainEnvelope<HomeMembershipBriefData>;
}
