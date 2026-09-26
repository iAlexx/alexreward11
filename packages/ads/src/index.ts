/**
 * Phase 11 — AdsGram + provider framework.
 *
 * Boundary contract: this package normalizes ad evidence and gates monetary eligibility.
 * It composes transactions through `@alex-rewards/rewards` and never imports
 * `@alex-rewards/ledger`, never posts a ledger transaction and never mutates a balance.
 */

export { AdsDomainError, isAdsMonetaryRefusal, ADS_MONETARY_REFUSAL_CODES } from './errors.js';
export type { AdsErrorCode } from './errors.js';

export {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  ADSGRAM_REWARD_URL_PATH,
  ADSGRAM_CLARIFICATION_REFERENCE,
  DEFAULT_AD_SESSION_TTL_SECONDS,
  PROVIDER_SIGNAL_CORRELATION_WINDOW_SECONDS,
  TERMINAL_AD_SESSION_STATES,
  LIVE_AD_SESSION_STATES,
  AD_SESSION_STATE_RANK,
  REQUIRED_LIMIT_DIMENSIONS,
  HARD_LIMIT_SCOPES,
  AD_REWARD_IDEMPOTENCY_PREFIX,
} from './constants.js';

export { isPool, withLedgerTransaction } from './db.js';
export type { AdsDb, Pool } from './db.js';

export type {
  AdFormat,
  AdProviderEventStatus,
  AdProviderStatus,
  AdSessionRecord,
  AdSessionSignalRecord,
  AdSessionState,
  AdSignalAuthenticity,
  AdSignalCorrelation,
  AdSignalSource,
  AdSignalType,
  AuthorizeAdInput,
  AuthorizeAdResult,
  AvailabilityInput,
  AvailabilityResult,
  CapabilityTriState,
  EnvironmentName,
  MembershipBonusUnavailablePolicy,
  ProviderCertificationCase,
  ProviderCertificationStatus,
  ProviderClarificationItem,
  ProviderClientSignal,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderLifecycleState,
  ProviderLimitMetric,
  ProviderLimitRuleRecord,
  ProviderLimitRuleVersionRef,
  ProviderLimitScope,
  ProviderLimitSourceType,
  ProviderLimitWindow,
  ProviderMonetaryStatus,
  ProviderSignalAuthentication,
  ProviderVerificationResult,
  RiskTier,
  SafePayload,
  VerificationContext,
} from './types.js';

export {
  capabilitiesToJson,
  isCapabilityConfirmed,
  isStrongServerSignalAuthentication,
  STRONG_SERVER_SIGNAL_AUTHENTICATION,
} from './provider-sdk/capabilities.js';
export type { ProviderCapabilities } from './provider-sdk/capabilities.js';

export type {
  ProviderManifest,
  ProviderReconciliationInput,
  ProviderReconciliationResult,
  ProviderReportingInput,
  ProviderReportingResult,
  RewardedAdProvider,
} from './provider-sdk/contract.js';

export {
  findProvider,
  getProvider,
  listProviderCodes,
  listProviders,
  registerProvider,
  requireRegisteredProviderForMonetaryUse,
  resetProviderRegistryForTests,
} from './provider-sdk/registry.js';

export {
  findDimension,
  requireDimension,
  resolveEffectiveProviderLimits,
} from './limits/resolve.js';
export type {
  EffectiveProviderLimitDimension,
  EffectiveProviderLimits,
  ResolveEffectiveProviderLimitsInput,
} from './limits/resolve.js';

export { evaluateProviderMonetaryEligibility } from './monetary/eligibility.js';
export type {
  ProviderMonetaryEligibilityInput,
  ProviderMonetaryEligibilityResult,
  ProviderMonetaryReasonCode,
} from './monetary/eligibility.js';

export { deriveSessionState, isTerminalAdSessionState } from './sessions/state.js';
export type {
  DeriveSessionStateInput,
  DeriveSessionStateResult,
  SessionDerivationReason,
} from './sessions/state.js';

export {
  appendAdSessionSignal,
  hashSafePayload,
  listAdSessionSignals,
  normalizeClientSignalType,
  normalizeProviderSignalType,
  redactSafePayload,
} from './sessions/signals.js';
export type {
  AppendAdSessionSignalInput,
  AppendAdSessionSignalResult,
} from './sessions/signals.js';

export {
  authorizeRewardedAdSession,
  readLatestHealthStatus,
  utcDayString,
} from './sessions/authorize.js';
export type { AuthorizeRewardedAdSessionInput } from './sessions/authorize.js';

export {
  adRewardIdempotencyKey,
  attemptVerifyAndIssueAdReward,
  expireAdSession,
  getAdSession,
  newAdOperationId,
  recordAdSessionOutcome,
  recordClientSignal,
  recordProviderSignal,
  refuseClientAuthoritativeProviderRequestCount,
} from './sessions/lifecycle.js';
export type {
  AdSessionFailureOutcome,
  AttemptVerifyAndIssueAdRewardInput,
  AttemptVerifyAndIssueAdRewardResult,
  RecordAdSessionOutcomeInput,
  RecordAdSessionOutcomeResult,
  RecordAdSignalResult,
  RecordClientSignalInput,
  RecordProviderSignalInput,
} from './sessions/lifecycle.js';

export {
  getProviderHealth,
  getProviderHealthOnClient,
  setProviderHealth,
  setProviderHealthOnClient,
} from './health.js';
export type { SetProviderHealthInput } from './health.js';

export {
  capabilitiesFromDbRow,
  countOpenClarifications,
  getProviderAdminView,
  hardCeilingFor,
  listProviderClarifications,
  loadProviderMonetaryFacts,
} from './admin-read.js';
export type {
  GetProviderAdminViewInput,
  ProviderAdminView,
  ProviderMonetaryFacts,
} from './admin-read.js';

export { getEarnSummaryForUser } from './user-read.js';
export type {
  EarnLimitUsage,
  EarnSummaryForUser,
  GetEarnSummaryForUserInput,
} from './user-read.js';

export {
  ADSGRAM_ADAPTER_VERSION,
  ADSGRAM_CAPABILITIES,
  ADSGRAM_CREDENTIALS_REFERENCE,
  ADSGRAM_MANIFEST_VERSION,
  ADSGRAM_NAME,
  ADSGRAM_OPEN_CLARIFICATION_CODES,
  ADSGRAM_POLICY_STATUS,
  adsGramManifest,
} from './providers/adsgram/manifest.js';

// Importing the adapter registers it in the compile-time provider registry.
export {
  AdsGramProvider,
  adsGramProvider,
  parseAdsGramRewardQuery,
} from './providers/adsgram/adapter.js';
export type { AdsGramRewardQuery } from './providers/adsgram/adapter.js';

export {
  ADSGRAM_CLIENT_SDK_INTEGRATION_PATH,
  ADSGRAM_CLIENT_SDK_PACKAGE,
  ADSGRAM_CLIENT_SDK_VERSION,
} from './providers/adsgram/client-boundary.js';
export type {
  ClientCompletionSignalEvent,
  ClientCompletionSignalPayload,
} from './providers/adsgram/client-boundary.js';

export { ingestAdsGramRewardUrl } from './webhooks/adsgram-reward.js';
export type {
  IngestAdsGramRewardUrlInput,
  IngestAdsGramRewardUrlResult,
  WebhookRateLimitDecision,
  WebhookRateLimitHook,
} from './webhooks/adsgram-reward.js';

export {
  PROVIDER_CERTIFICATION_CASES,
  runProviderCertificationCases,
} from './certification/harness.js';
export type {
  ProviderCertificationCaseContext,
  ProviderCertificationCaseOutcome,
  ProviderCertificationCaseResult,
  ProviderCertificationCaseRunner,
  ProviderCertificationCategory,
  ProviderCertificationDeps,
  ProviderCertificationRunResult,
  ProviderCertificationSummary,
} from './certification/harness.js';
