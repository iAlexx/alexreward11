import type { MembershipBonusUnavailablePolicy } from '@alex-rewards/rewards';

/**
 * Shared Phase 11 ad-domain types.
 *
 * Every enum here mirrors a PostgreSQL enum created in migrations 0001/0003/0009/0030.
 * The database remains authoritative; these unions exist so the adapter framework can
 * stay strictly typed without importing the ledger.
 */

/** provider_monetary_status (0001). Only APPROVED may receive production monetary traffic. */
export type ProviderMonetaryStatus = 'BLOCKED' | 'TEST_ONLY' | 'APPROVED' | 'SUSPENDED';

/** provider_signal_authentication (0001). */
export type ProviderSignalAuthentication =
  'NONE' | 'SHARED_SECRET' | 'HMAC_SIGNATURE' | 'MUTUAL_TLS' | 'IP_ALLOWLIST' | 'OAUTH';

/** ad_provider_status (0001). */
export type AdProviderStatus = 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'DISABLED';

/** provider_lifecycle_state (0001). */
export type ProviderLifecycleState =
  | 'CONTRACTED'
  | 'TECH_REVIEW'
  | 'SANDBOX'
  | 'SECURITY_VERIFIED'
  | 'ECONOMICS_VERIFIED'
  | 'LIMITED_TEST'
  | 'APPROVED'
  | 'PRODUCTION'
  | 'BLOCKED'
  | 'SUSPENDED'
  | 'REJECTED';

/** provider_health_status (0030). */
export type ProviderHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'SUSPENDED';

/** ad_format (0001). */
export type AdFormat = 'REWARDED_VIDEO' | 'REWARDED_INTERSTITIAL' | 'REWARDED_TASK' | 'OTHER';

/** ad_session_state (0001) — derived, never client-asserted. */
export type AdSessionState =
  | 'CREATED'
  | 'QUOTED'
  | 'AUTHORIZED'
  | 'REQUESTED'
  | 'LOADED'
  | 'STARTED'
  | 'CLIENT_COMPLETION_RECEIVED'
  | 'PROVIDER_CONFIRMATION_RECEIVED'
  | 'PENDING_VERIFICATION'
  | 'VERIFIED'
  | 'REWARDED'
  | 'NO_FILL'
  | 'FAILED'
  | 'SKIPPED'
  | 'REJECTED'
  | 'EXPIRED';

/** ad_signal_source (0001). */
export type AdSignalSource = 'CLIENT' | 'PROVIDER' | 'SYSTEM';

/** ad_signal_authenticity_status (0001). */
export type AdSignalAuthenticity = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';

/** ad_signal_correlation_status (0001). */
export type AdSignalCorrelation = 'UNCORRELATED' | 'CORRELATED' | 'AMBIGUOUS' | 'REJECTED';

/** ad_provider_event_status (0001). */
export type AdProviderEventStatus = 'RECEIVED' | 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'FAILED';

/** provider_limit_scope (0001). */
export type ProviderLimitScope =
  'PROVIDER_HARD' | 'CONTRACT' | 'PLATFORM_SOFT' | 'USER_TIER' | 'COUNTRY_OVERRIDE';

/** provider_limit_metric (0001). */
export type ProviderLimitMetric = 'REQUEST' | 'SUCCESS';

/** provider_limit_window (0001). */
export type ProviderLimitWindow = 'HOUR' | 'ROLLING_24H' | 'UTC_DAY';

/** provider_limit_source_type (0001). */
export type ProviderLimitSourceType =
  'CONTRACT' | 'OFFICIAL_DOCUMENTATION' | 'WRITTEN_SUPPORT' | 'PROVIDER_ACCOUNT_CONFIG';

/** provider_certification_case (0001). */
export type ProviderCertificationCase =
  | 'AVAILABILITY_SUCCESS'
  | 'NO_FILL'
  | 'LOAD_FAILURE'
  | 'START_FAILURE'
  | 'VALID_COMPLETION'
  | 'DUPLICATE_CLIENT_CALLBACK'
  | 'DUPLICATE_SERVER_CALLBACK'
  | 'SERVER_CALLBACK_BEFORE_CLIENT_CALLBACK'
  | 'LATE_CALLBACK'
  | 'INVALID_OR_MISSING_SIGNATURE'
  | 'REPLAY'
  | 'WRONG_USER'
  | 'WRONG_SESSION'
  | 'AMBIGUOUS_CORRELATION'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_OUTAGE'
  | 'REQUEST_CAP_REACHED'
  | 'SUCCESSFUL_CAP_REACHED'
  | 'COUNTRY_NOT_ELIGIBLE'
  | 'PROVIDER_SUSPENDED'
  | 'REPORTING_IMPORT'
  | 'SETTLEMENT_MISMATCH'
  | 'INVALID_TRAFFIC_REVERSAL_INPUT';

/** provider_certification_status (0001). */
export type ProviderCertificationStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'BLOCKED';

/** risk_tier (0001). */
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** environment_name (0001). */
export type EnvironmentName = 'LOCAL' | 'STAGING' | 'PRODUCTION';

/**
 * Tri-state capability. `UNKNOWN` is an honest answer and is treated as a *refusal*
 * by the monetary gate — never as an implied `SUPPORTED`.
 */
export type CapabilityTriState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';

/** Canonical normalized signal vocabulary shared by client, provider and system evidence. */
export type AdSignalType =
  | 'SESSION_CREATED'
  | 'QUOTE_COMMITTED'
  | 'AUTHORIZATION_PASSED'
  | 'REQUEST_APPROVED'
  | 'AD_LOADED'
  | 'AD_STARTED'
  | 'CLIENT_COMPLETION'
  | 'PROVIDER_CONFIRMATION'
  | 'NO_FILL'
  | 'LOAD_FAILURE'
  | 'START_FAILURE'
  | 'TECHNICAL_FAILURE'
  | 'USER_SKIPPED'
  | 'POLICY_REJECTION'
  | 'MONETARY_GATE_BLOCKED'
  | 'VERIFICATION_PASSED'
  | 'REWARD_COMMITTED'
  | 'SESSION_EXPIRED';

/** Redacted, primitive-only evidence payload. Never holds secrets or raw provider bodies. */
export type SafePayload = Readonly<Record<string, string | number | boolean | null>>;

export interface AvailabilityInput {
  readonly userId: string;
  readonly providerId: string;
  readonly placementCode?: string;
  readonly countryCode?: string;
  readonly environment?: EnvironmentName;
  readonly asOf?: Date;
}

export interface AvailabilityResult {
  readonly available: boolean;
  /** Normalized, provider-neutral reason codes. Empty when available. */
  readonly reasonCodes: readonly string[];
  readonly health: ProviderHealthStatus;
  /** True only when the adapter can prove inventory; AdsGram cannot, so it stays false. */
  readonly inventoryConfirmed: boolean;
}

export interface AuthorizeAdInput {
  readonly userId: string;
  readonly assetId: string;
  readonly budgetPeriodId: string;
  readonly adUnitId?: string | null;
  readonly countryCode?: string | null;
  readonly countryGroup?: string | null;
  readonly riskTier?: RiskTier | null;
  readonly environment?: EnvironmentName;
  readonly sessionTtlSeconds?: number;
  readonly evaluateMembershipBonus?: boolean;
  /** Required by the Reward Engine whenever membership bonus evaluation is requested. */
  readonly bonusUnavailablePolicy?: MembershipBonusUnavailablePolicy | null;
  readonly membershipBonusBudgetPeriodId?: string | null;
  readonly asOf?: Date;
}

export interface AuthorizeAdResult {
  readonly adSessionId: string;
  readonly rewardQuoteId: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly state: AdSessionState;
  readonly expiresAt: string;
  readonly quotedAmountAtomic: string;
  readonly baseAmountAtomic: string;
  readonly membershipBonusAmountAtomic: string;
  readonly effectiveRequestLimit: number;
  readonly effectiveSuccessLimit: number;
  readonly limitRuleVersions: readonly ProviderLimitRuleVersionRef[];
}

/** Normalized client-side event. Client evidence is forensic only (Spec V1.3 §20). */
export interface ProviderClientSignal {
  readonly signalType: AdSignalType;
  readonly adSessionId: string | null;
  readonly providerEventId: string | null;
  readonly occurredAt: string | null;
  readonly safePayload: SafePayload;
  /** Always UNVERIFIED for client-originated evidence. */
  readonly authenticity: 'UNVERIFIED';
  readonly financialAuthority: false;
}

export interface VerificationContext {
  readonly providerId: string;
  readonly receivedAt: Date;
  readonly remoteIpRedacted?: string | null;
  readonly expectedTelegramUserId?: string | null;
}

/**
 * Result of inspecting a provider server signal.
 *
 * `authenticity` is a factual statement about what could be *proved*. An adapter
 * without a shared secret / signature MUST report `UNVERIFIED` and
 * `authenticationMethod: 'NONE'`; it must never claim cryptographic authenticity.
 */
export interface ProviderVerificationResult {
  readonly signalType: AdSignalType;
  readonly authenticity: AdSignalAuthenticity;
  readonly authenticationMethod: ProviderSignalAuthentication;
  readonly authenticationStrength: 'NONE' | 'INSUFFICIENT' | 'STRONG';
  readonly correlation: AdSignalCorrelation;
  readonly providerEventId: string | null;
  readonly telegramUserId: string | null;
  readonly occurredAt: string | null;
  readonly safePayload: SafePayload;
  readonly reasonCodes: readonly string[];
  /** Always false for signals that cannot be authenticated. */
  readonly monetaryAuthority: boolean;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: ProviderHealthStatus;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detailsRedacted: Readonly<Record<string, unknown>>;
}

export interface ProviderLimitRuleVersionRef {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly limitScope: ProviderLimitScope;
  readonly limitMetric: ProviderLimitMetric;
  readonly limitWindow: ProviderLimitWindow;
  readonly maxCount: number;
  readonly sourceType: ProviderLimitSourceType;
  readonly sourceReference: string;
}

export interface ProviderLimitRuleRecord extends ProviderLimitRuleVersionRef {
  readonly providerId: string;
  readonly countryCode: string | null;
  readonly riskTier: RiskTier | null;
  readonly cooldownSeconds: number | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly approvedByAdminId: string | null;
  readonly approvedAt: string | null;
}

export interface AdSessionSignalRecord {
  readonly id: string;
  readonly adSessionId: string;
  readonly source: AdSignalSource;
  readonly signalType: AdSignalType;
  readonly providerEventId: string | null;
  readonly occurredAt: string | null;
  readonly receivedAt: string;
  readonly authenticity: AdSignalAuthenticity;
  readonly correlation: AdSignalCorrelation;
  readonly safePayloadHash: string;
  readonly safePayload: SafePayload;
}

export interface AdSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly providerId: string;
  readonly adUnitId: string | null;
  readonly rewardQuoteId: string | null;
  readonly state: AdSessionState;
  readonly utcDay: string;
  readonly providerRequestCounted: boolean;
  readonly successfulRewardCounted: boolean;
  readonly countryCode: string | null;
  readonly failureCode: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export type { MembershipBonusUnavailablePolicy };

export interface ProviderClarificationItem {
  readonly id: string;
  readonly itemCode: string;
  readonly title: string;
  readonly status: 'OPEN' | 'RESOLVED' | 'WAIVED';
  readonly detail: string;
  readonly evidenceReference: string | null;
  readonly updatedAt: string;
}
