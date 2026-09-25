import {
  ADSGRAM_CLARIFICATION_REFERENCE,
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
} from '../../constants.js';
import type { ProviderCapabilities } from '../../provider-sdk/capabilities.js';
import type { ProviderManifest } from '../../provider-sdk/contract.js';
import type { EnvironmentName } from '../../types.js';

export { ADSGRAM_CODE, ADSGRAM_PROVIDER_ID };

export const ADSGRAM_NAME = 'AdsGram';
export const ADSGRAM_MANIFEST_VERSION = 1;
export const ADSGRAM_ADAPTER_VERSION = '1.0.0-phase11';
export const ADSGRAM_CREDENTIALS_REFERENCE = 'secret://adsgram/reward-url-credentials';
export const ADSGRAM_POLICY_STATUS = 'BLOCKED_PENDING_CLARIFICATION';

/**
 * Declared AdsGram capabilities, mirroring the seeded `ad_providers.capabilities` row in
 * migration 0030.
 *
 * Every value the provider has not documented for this integration is declared honestly:
 *  - `uniqueProviderEventId: UNKNOWN` — no documented per-impression event id;
 *  - `serverSignalAuthentication: NONE` — the documented Reward URL carries no signature;
 *  - `sessionOrImpressionCorrelation: UNKNOWN` — unambiguous per-impression identity is
 *    not confirmed;
 *  - `retryBehaviorDocumented` / `deliveryWindowDocumented: false`;
 *  - `providerSideRequestLimit: UNKNOWN` — provider-side counting cannot be proved;
 *  - `cashRewardPolicyApproved: false` and `productionMonetaryStatus: BLOCKED`.
 *
 * These are the exact inputs the provider-neutral monetary gate reads. They change when
 * AdsGram answers the clarification register and the Owner approves the result — not when
 * the adapter is refactored.
 */
export const ADSGRAM_CAPABILITIES: ProviderCapabilities = {
  rewarded: true,
  interstitial: true,
  taskAds: true,
  serverRewardCallback: true,
  uniqueProviderEventId: 'UNKNOWN',
  serverSignalAuthentication: 'NONE',
  sessionOrImpressionCorrelation: 'UNKNOWN',
  retryBehaviorDocumented: false,
  deliveryWindowDocumented: false,
  providerSideRequestLimit: 'UNKNOWN',
  countryReporting: true,
  revenueReportingApi: true,
  cashRewardPolicyApproved: false,
  productionMonetaryStatus: 'BLOCKED',
};

/** Clarification item codes seeded by migration 0030 that block production money. */
export const ADSGRAM_OPEN_CLARIFICATION_CODES: readonly string[] = [
  'REWARD_URL_AUTHENTICITY',
  'SESSION_CORRELATION',
  'RETRY_SEMANTICS',
  'DELIVERY_WINDOW',
  'PROVIDER_SIDE_REQUEST_LIMIT',
  'MODERATION_COMPLIANCE',
];

export function adsGramManifest(environment: EnvironmentName = 'STAGING'): ProviderManifest {
  return {
    providerId: ADSGRAM_PROVIDER_ID,
    providerCode: ADSGRAM_CODE,
    name: ADSGRAM_NAME,
    manifestVersion: ADSGRAM_MANIFEST_VERSION,
    adapterVersion: ADSGRAM_ADAPTER_VERSION,
    environment,
    supportedFormats: ['REWARDED_VIDEO'],
    credentialsReference: ADSGRAM_CREDENTIALS_REFERENCE,
    policyStatus: ADSGRAM_POLICY_STATUS,
    productionMonetaryStatus: ADSGRAM_CAPABILITIES.productionMonetaryStatus,
    clarificationReference: ADSGRAM_CLARIFICATION_REFERENCE,
  };
}
