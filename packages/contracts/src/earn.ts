/**
 * Earn surface read models (Phase 12).
 *
 * This is the user-facing projection of the provider policy state, not the Owner/admin view:
 * it carries no credentials, no revenue data, no server configuration and no clarification
 * detail. `productionMonetaryStatus` and `monetaryEligible` are reported exactly as the
 * database and the provider-neutral monetary gate decide them.
 */

import type { ServerDomainAvailability } from './common.js';

export type ProviderMonetaryStatusDto = 'BLOCKED' | 'TEST_ONLY' | 'APPROVED' | 'SUSPENDED';

export type ProviderHealthStatusDto = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'SUSPENDED';

export type EarnLimitMetric = 'REQUEST' | 'SUCCESS';

/**
 * Measurement basis for used/remaining counts (provider-neutral).
 * AdsGram REQUEST uses SERVER_AUTHORIZED_SESSION_CONSERVATIVE while clarification
 * PROVIDER_SIDE_REQUEST_LIMIT remains open (P11-01).
 */
export type EarnUsageBasisDto =
  'SERVER_AUTHORIZED_SESSION_CONSERVATIVE' | 'AUTHORITATIVE_PROVIDER_REQUEST' | 'SUCCESSFUL_REWARD';

export interface ProviderHealthDto {
  readonly status: ProviderHealthStatusDto;
  readonly observedAt: string;
}

/**
 * Remaining opportunities on one versioned limit dimension.
 *
 * `maxCount` always comes from an ACTIVE `provider_limit_rules` version; the platform never
 * invents a default cap, so a missing rule is reported as `configured: false`.
 * `usageBasis` tells the client what `usedCount`/`remaining` measure — never invent a label
 * that claims proven provider requests when the basis is conservative sessions.
 */
export interface EarnOpportunityLimitDto {
  readonly metric: EarnLimitMetric;
  readonly configured: boolean;
  readonly maxCount: number | null;
  readonly usedCount: number;
  readonly remaining: number | null;
  readonly decidingRuleId: string | null;
  readonly decidingRuleVersion: number | null;
  readonly usageBasis: EarnUsageBasisDto;
}

export interface EarnProviderCardDto {
  readonly providerCode: string;
  readonly name: string;
  readonly utcDay: string;
  readonly productionMonetaryStatus: ProviderMonetaryStatusDto;
  readonly monetaryEligible: boolean;
  readonly reasonCodes: readonly string[];
  readonly health: ProviderHealthDto;
  readonly rewardedUseAllowed: boolean;
  readonly opportunitiesRemaining: {
    readonly request: EarnOpportunityLimitDto;
    readonly success: EarnOpportunityLimitDto;
  };
  /** Public SDK block id from `ad_units.client_config.blockId`; never server configuration. */
  readonly blockIdPublic: string | null;
  /**
   * Server-published locators for `POST /v1/ads/sessions/authorize`.
   * Null when no ACTIVE quote budget can be published — the client must not invent them.
   */
  readonly authorizeAssetId: string | null;
  readonly authorizeBudgetPeriodId: string | null;
}

export interface EarnSummaryResponse {
  readonly status: ServerDomainAvailability;
  readonly asOf: string;
  readonly providers: readonly EarnProviderCardDto[];
  readonly reasonCode?: string;
}
