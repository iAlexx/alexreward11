import type {
  CapabilityTriState,
  ProviderMonetaryStatus,
  ProviderSignalAuthentication,
} from '../types.js';

/**
 * Normalized provider capability declaration (Spec V1.3 §19, §156D.3).
 *
 * Honesty rule: a capability that the provider has not documented is declared
 * `UNKNOWN` / `false` / `NONE`. The monetary gate reads these fields directly, so an
 * optimistic declaration here would silently weaken a financial control.
 */
export interface ProviderCapabilities {
  readonly rewarded: boolean;
  readonly interstitial: boolean;
  readonly taskAds: boolean;
  readonly serverRewardCallback: boolean;
  readonly uniqueProviderEventId: CapabilityTriState;
  readonly serverSignalAuthentication: ProviderSignalAuthentication;
  readonly sessionOrImpressionCorrelation: CapabilityTriState;
  readonly retryBehaviorDocumented: boolean;
  readonly deliveryWindowDocumented: boolean;
  readonly providerSideRequestLimit: CapabilityTriState;
  readonly countryReporting: boolean;
  readonly revenueReportingApi: boolean;
  /** Owner-approved written policy permitting cash-equivalent rewarded traffic. */
  readonly cashRewardPolicyApproved: boolean;
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
}

/**
 * Authentication methods that can carry a protected provider server signal.
 * `NONE` and `IP_ALLOWLIST` alone cannot prove per-impression authenticity.
 */
export const STRONG_SERVER_SIGNAL_AUTHENTICATION: ReadonlySet<ProviderSignalAuthentication> =
  new Set(['SHARED_SECRET', 'HMAC_SIGNATURE', 'MUTUAL_TLS', 'OAUTH']);

export function isStrongServerSignalAuthentication(method: ProviderSignalAuthentication): boolean {
  return STRONG_SERVER_SIGNAL_AUTHENTICATION.has(method);
}

export function isCapabilityConfirmed(state: CapabilityTriState): boolean {
  return state === 'SUPPORTED';
}

/**
 * Project declared capabilities onto the `ad_providers.capabilities` JSONB shape used
 * by migration 0030 so admin reads and adapter declarations stay comparable.
 */
export function capabilitiesToJson(
  capabilities: ProviderCapabilities,
): Readonly<Record<string, string | boolean>> {
  return {
    rewarded: capabilities.rewarded,
    interstitial: capabilities.interstitial,
    taskAds: capabilities.taskAds,
    serverRewardCallback: capabilities.serverRewardCallback,
    uniqueProviderEventId:
      capabilities.uniqueProviderEventId === 'UNKNOWN'
        ? 'UNKNOWN'
        : capabilities.uniqueProviderEventId === 'SUPPORTED',
    serverSignalAuthentication: capabilities.serverSignalAuthentication,
    sessionOrImpressionCorrelation:
      capabilities.sessionOrImpressionCorrelation === 'UNKNOWN'
        ? 'UNKNOWN'
        : capabilities.sessionOrImpressionCorrelation === 'SUPPORTED',
    retryBehaviorDocumented: capabilities.retryBehaviorDocumented,
    deliveryWindowDocumented: capabilities.deliveryWindowDocumented,
    providerSideRequestLimit:
      capabilities.providerSideRequestLimit === 'UNKNOWN'
        ? 'UNKNOWN'
        : capabilities.providerSideRequestLimit === 'SUPPORTED',
    countryReporting: capabilities.countryReporting,
    revenueReportingApi: capabilities.revenueReportingApi,
    cashRewardPolicyApproved: capabilities.cashRewardPolicyApproved,
    productionMonetaryStatus: capabilities.productionMonetaryStatus,
  };
}
