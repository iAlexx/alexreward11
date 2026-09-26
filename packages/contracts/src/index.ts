export const HEALTH_CONTRACT_VERSION = '1' as const;

export type HealthState = 'ok' | 'degraded' | 'unavailable';

export interface HealthComponent {
  readonly name: string;
  readonly state: HealthState;
  readonly latencyMs?: number;
}

export interface HealthResponse {
  readonly contractVersion: typeof HEALTH_CONTRACT_VERSION;
  readonly service: string;
  readonly status: HealthState;
  readonly timestamp: string;
  readonly components?: readonly HealthComponent[];
}

// ---------------------------------------------------------------------------
// Phase 12 — Mini App read models
// ---------------------------------------------------------------------------

export { SUPPORTED_LOCALE_CODES, isLocaleCode } from './common.js';
export type {
  DomainAvailability,
  DomainEnvelope,
  DomainReasonCode,
  LocaleCode,
  ServerDomainAvailability,
} from './common.js';

export type { BalanceBucketDto, BalanceBucketState, UserBalancesResponse } from './balances.js';

export type {
  EarnLimitMetric,
  EarnOpportunityLimitDto,
  EarnProviderCardDto,
  EarnSummaryResponse,
  EarnUsageBasisDto,
  ProviderHealthDto,
  ProviderHealthStatusDto,
  ProviderMonetaryStatusDto,
} from './earn.js';

export type {
  HomeAnnouncementData,
  HomeLatestWithdrawalData,
  HomeMembershipBriefData,
  HomeMissionsData,
  HomeSummaryResponse,
  HomeTodayAdsData,
} from './home.js';

export type { TaskListItemDto, TaskProgressStateDto, TasksListResponse } from './tasks.js';

export type { ReferralsSummaryData, ReferralsSummaryResponse } from './referrals.js';

export type {
  TonProofBindRequest,
  TonProofBindResponse,
  TonProofChallengeResponse,
  UserWalletDto,
  WalletSummaryResponse,
  WalletVerificationMethodDto,
} from './wallets.js';

export type {
  PatchUserSettingsRequest,
  PublicPayoutIdentityMode,
  UserSettingsResponse,
} from './settings.js';

export type {
  AdSessionStateDto,
  AdSessionStateUserLabel,
  AdSessionStateUserLabelMap,
  UserLabelForAdSessionState,
} from './ad-session-labels.js';
