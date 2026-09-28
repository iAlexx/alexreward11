/**
 * Phase 13 — Admin HTTP API contracts.
 *
 * Admin is a control/read surface, never financial truth. Money fields are strings.
 * Domains that cannot be read honestly use DomainEnvelope with UNAVAILABLE — never
 * fabricate zeros as known values.
 */

import type { DomainEnvelope, ServerDomainAvailability } from './common.js';

export const ADMIN_API_CONTRACT_VERSION = '1' as const;

/** V1 RBAC: OWNER only. */
export type AdminRoleCode = 'OWNER';

export type AdminAvailabilityLabel =
  | 'READY'
  | 'EMPTY'
  | 'UNAVAILABLE'
  | 'ENGINE_NOT_ENABLED'
  | 'NOT_CONFIGURED';

export interface AdminDomainSlot<TData> {
  readonly status: AdminAvailabilityLabel;
  readonly data: TData | null;
  readonly reasonCode?: string;
}

// ---------------------------------------------------------------------------
// High-impact confirmation binding
// ---------------------------------------------------------------------------

/**
 * Display-only confirmation binding helper material.
 * MUST NOT authorize Admin mutations — server confirmationId consume is mandatory (P13-01).
 */
export interface HighImpactConfirmationBinding {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly expiresAt: string;
  /** Canonical JSON of the mutation payload that was confirmed. */
  readonly payloadCanonical: string;
  /** SHA-256 hex of the confirmation material — display/digest aid only. */
  readonly confirmationHash: string;
}

export interface HighImpactConfirmationInput {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly expiresAt: string | Date;
  readonly payload: unknown;
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(',')}}`;
}

async function sha256Hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function confirmationMaterial(input: {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly expiresAtIso: string;
  readonly payloadCanonical: string;
}): string {
  return [
    input.action,
    input.resourceType,
    input.resourceId,
    input.expectedVersion,
    input.expiresAtIso,
    input.payloadCanonical,
  ].join('\n');
}

/** Build display-only confirmation digest material. Does not authorize mutations. */
export async function createHighImpactConfirmation(
  input: HighImpactConfirmationInput,
): Promise<HighImpactConfirmationBinding> {
  const expiresAtIso =
    input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt;
  const payloadCanonical = canonicalizeJson(input.payload);
  const confirmationHash = await sha256Hex(
    confirmationMaterial({
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      expiresAtIso,
      payloadCanonical,
    }),
  );
  return {
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    expectedVersion: input.expectedVersion,
    expiresAt: expiresAtIso,
    payloadCanonical,
    confirmationHash,
  };
}

export type HighImpactConfirmationFailure =
  | 'EXPIRED'
  | 'ACTION_MISMATCH'
  | 'RESOURCE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'PAYLOAD_CHANGED'
  | 'HASH_MISMATCH';

/**
 * Validate display-only confirmation digest material.
 * Does not authorize mutations — use server confirmationId consume instead.
 */
export async function assertHighImpactConfirmationValid(
  binding: HighImpactConfirmationBinding,
  attempt: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly expectedVersion: string;
    readonly payload: unknown;
    readonly nowMs?: number;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: HighImpactConfirmationFailure }> {
  const nowMs = attempt.nowMs ?? Date.now();
  if (Date.parse(binding.expiresAt) <= nowMs) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (binding.action !== attempt.action) {
    return { ok: false, reason: 'ACTION_MISMATCH' };
  }
  if (
    binding.resourceType !== attempt.resourceType ||
    binding.resourceId !== attempt.resourceId
  ) {
    return { ok: false, reason: 'RESOURCE_MISMATCH' };
  }
  if (binding.expectedVersion !== attempt.expectedVersion) {
    return { ok: false, reason: 'VERSION_MISMATCH' };
  }
  const payloadCanonical = canonicalizeJson(attempt.payload);
  if (payloadCanonical !== binding.payloadCanonical) {
    return { ok: false, reason: 'PAYLOAD_CHANGED' };
  }
  const expectedHash = await sha256Hex(
    confirmationMaterial({
      action: binding.action,
      resourceType: binding.resourceType,
      resourceId: binding.resourceId,
      expectedVersion: binding.expectedVersion,
      expiresAtIso: binding.expiresAt,
      payloadCanonical,
    }),
  );
  if (expectedHash !== binding.confirmationHash) {
    return { ok: false, reason: 'HASH_MISMATCH' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AdminOverviewDomainDto {
  readonly key: string;
  readonly status: AdminAvailabilityLabel;
  readonly reasonCode?: string;
}

export interface AdminOverviewResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly domains: readonly AdminOverviewDomainDto[];
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface AdminUserListItemDto {
  readonly id: string;
  readonly telegramUserId: string | null;
  readonly username: string | null;
  readonly locale: string | null;
  readonly countryCode: string | null;
  readonly status: string;
  readonly riskTier: string | null;
  readonly lastActiveAt: string | null;
  readonly createdAt: string;
}

export interface AdminUsersListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly AdminUserListItemDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number | null;
  readonly totalKnown: boolean;
}

export interface AdminUserDetailResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly user: AdminUserListItemDto;
  readonly tabs: {
    readonly overview: DomainEnvelope<Record<string, unknown>>;
    readonly ledger: DomainEnvelope<Record<string, unknown>>;
    readonly rewards: DomainEnvelope<Record<string, unknown>>;
    readonly ads: DomainEnvelope<Record<string, unknown>>;
    readonly withdrawals: DomainEnvelope<Record<string, unknown>>;
    readonly wallets: DomainEnvelope<Record<string, unknown>>;
    readonly referrals: DomainEnvelope<null>;
    readonly risk: DomainEnvelope<Record<string, unknown>>;
    readonly security: DomainEnvelope<Record<string, unknown>>;
    readonly support: DomainEnvelope<Record<string, unknown>>;
    readonly audit: DomainEnvelope<Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export interface AdminWithdrawalListItemDto {
  readonly id: string;
  readonly publicId: string;
  readonly userId: string;
  readonly state: string;
  readonly requestedAmountAtomic: string;
  readonly feeAmountAtomic: string;
  readonly netAmountAtomic: string;
  readonly requestedAt: string;
}

export interface AdminWithdrawalsListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly AdminWithdrawalListItemDto[];
  readonly page: number;
  readonly pageSize: number;
}

export interface AdminWithdrawalDecisionRequest {
  readonly decision: 'APPROVE' | 'HOLD' | 'REJECT';
  readonly reason: string;
  readonly expectedVersion: string;
  readonly expectedState: string;
  readonly idempotencyKey: string;
  readonly confirmationId: string;
}

// ---------------------------------------------------------------------------
// Hot wallet (public surface only — never secrets)
// ---------------------------------------------------------------------------

export interface AdminHotWalletResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly status: ServerDomainAvailability;
  readonly reasonCode?: string;
  readonly data: {
    readonly hotWalletId: string;
    readonly address: string;
    readonly friendlyAddress: string | null;
    readonly walletVersion: string;
    readonly signerType: string;
    /** Public signer fingerprint / external reference — never private key material. */
    readonly signerReference: string;
    readonly networkCode: string;
    readonly usdtBalanceAtomic: string | null;
    readonly tonBalanceAtomic: string | null;
    readonly balancesKnown: boolean;
    readonly lastChainSyncAt: string | null;
    readonly reservedPayoutsAtomic: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Ledger (read-only)
// ---------------------------------------------------------------------------

export interface AdminLedgerLookupResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly transactions: DomainEnvelope<readonly Record<string, unknown>[]>;
  readonly accounts: DomainEnvelope<readonly Record<string, unknown>[]>;
}

// ---------------------------------------------------------------------------
// Ads / Providers
// ---------------------------------------------------------------------------

export interface AdminProviderListItemDto {
  readonly providerId: string;
  readonly providerCode: string;
  readonly name: string;
  readonly status: string;
  readonly productionMonetaryStatus: string;
  readonly lifecycleState: string;
}

export interface AdminProvidersListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly AdminProviderListItemDto[];
}

export interface AdminProviderLimitChangeRequest {
  readonly providerCode: string;
  readonly limitScope: string;
  readonly limitMetric: 'REQUEST' | 'SUCCESS';
  readonly limitWindow: string;
  readonly maxCount: number;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly reason: string;
  readonly expectedVersion: string;
  readonly oldMaxCount: number;
  readonly impactPreview?: Record<string, unknown>;
  readonly activate?: boolean;
  readonly countryCode?: string | null;
  readonly riskTier?: string | null;
  readonly confirmationId: string;
}

export interface AdminProviderLimitChangeResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly oldMaxCount: number;
  readonly newMaxCount: number;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly impactPreview: Record<string, unknown> | null;
  readonly status: string;
}

export interface AdminProviderMonetaryApprovalRequest {
  readonly providerCode: string;
  readonly targetStatus: 'APPROVED' | 'BLOCKED' | 'TEST_ONLY' | 'SUSPENDED';
  readonly reason: string;
  readonly expectedVersion: string;
  readonly confirmationId: string;
}

// ---------------------------------------------------------------------------
// Reward engine / entitlements
// ---------------------------------------------------------------------------

export interface AdminRewardRulesListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly Record<string, unknown>[];
}

export interface AdminCreateRewardRuleVersionRequest {
  readonly code: string;
  readonly sourceType: string;
  readonly assetId: string;
  readonly reason: string;
  readonly expectedVersion: string;
  readonly userShareBps?: number | null;
  readonly safetyFactorBps?: number | null;
  readonly estimatedEcpmAtomic?: string | null;
  readonly minRewardAtomic?: string | null;
  readonly maxRewardAtomic?: string | null;
  readonly fixedRewardAtomic?: string | null;
  readonly pendingHoldSeconds?: number;
  readonly quoteTtlSeconds?: number;
  readonly providerId?: string | null;
  readonly countryGroup?: string | null;
  readonly activate?: boolean;
  readonly confirmationId: string;
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export interface AdminFounderGrantRequest {
  readonly targetUserId: string;
  readonly reason: string;
  readonly paymentReferenceRedacted: string;
  readonly expectedVersion: string;
  readonly idempotencyKey?: string;
  readonly confirmationId: string;
}

export interface AdminFounderGrantResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly membershipId: string;
  readonly founderNumber: number;
  readonly planCode: string;
  /** Always false — Founder grant is membership-only, never money. */
  readonly moneyIssued: false;
  readonly ledgerPostingsCreated: false;
}

// ---------------------------------------------------------------------------
// Policy Center
// ---------------------------------------------------------------------------

export type AdminPolicyRuleFamily =
  | 'PROVIDER_LIMITS'
  | 'FEATURE_FLAGS'
  | 'EXPOSURE_LIMITS'
  | 'REWARD_RULES'
  | 'BENEFIT_RULES'
  | 'WITHDRAWAL_LIMITS';

export interface AdminPolicyFamiliesResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly families: readonly {
    readonly family: AdminPolicyRuleFamily;
    readonly typedOnly: true;
    readonly acceptsArbitraryCode: false;
  }[];
}

export interface AdminPolicyArbitraryPayloadRequest {
  readonly family: string;
  readonly expression?: string;
  readonly script?: string;
  readonly sql?: string;
  readonly eval?: string;
  readonly javascript?: string;
}

// ---------------------------------------------------------------------------
// Economics / Exposure (P13-04 — honest metric contract)
// ---------------------------------------------------------------------------

export type AdminEconomicsMetricCode =
  | 'PROVIDER_ESTIMATED_REVENUE'
  | 'PROVIDER_SETTLED_CONFIRMED_REVENUE'
  | 'PROVIDER_RECEIVABLES'
  | 'BASE_USER_REWARD_EXPENSE'
  | 'MEMBERSHIP_FOUNDER_BONUS_EXPENSE'
  | 'REFERRAL_BONUS_EXPENSE'
  | 'MISSION_TASK_REWARD_EXPENSE'
  | 'WITHDRAWAL_FEE_REVENUE'
  | 'TON_NETWORK_FEE_EXPENSE'
  | 'INVALID_TRAFFIC_ADJUSTMENTS_LOSS'
  | 'NET_CONTRIBUTION_MARGIN_ESTIMATE'
  | 'HOT_WALLET_COVERAGE'
  | 'OUTSTANDING_USER_LIABILITIES'
  /** Operational payout principal only — never labeled margin/revenue. */
  | 'CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL';

export type AdminEconomicsMetricBasis =
  | 'ESTIMATED'
  | 'ACCRUED'
  | 'SETTLED'
  | 'ACTUAL'
  | 'OPERATIONAL';

export interface AdminEconomicsMetricDto {
  readonly metric: AdminEconomicsMetricCode;
  readonly basis: AdminEconomicsMetricBasis;
  readonly amountAtomic: string | null;
  readonly status: AdminAvailabilityLabel;
  readonly reasonCode?: string;
  readonly asOf?: string;
}

/** @deprecated Prefer AdminEconomicsMetricDto — kept only for transitional display helpers. */
export interface AdminEconomicsAmountDto {
  readonly kind: 'ESTIMATED' | 'SETTLED';
  readonly amountAtomic: string | null;
  readonly status: AdminAvailabilityLabel;
  readonly reasonCode?: string;
}

export interface AdminEconomicsResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly metrics: readonly AdminEconomicsMetricDto[];
  readonly note: 'estimates_are_not_settled_and_withdrawal_principal_is_not_margin';
}

export interface AdminWebConfirmationPrepareRequest {
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly payload: unknown;
}

export interface AdminWebConfirmationPrepareResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly confirmationId: string;
  readonly expiresAt: string;
  readonly payloadDigest: string;
  readonly confirmationPhrase: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
}

export interface AdminWebConfirmationConfirmResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly confirmationId: string;
  readonly confirmedAt: string;
  readonly expiresAt: string;
  readonly payloadDigest: string;
}

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

export interface AdminExposureLimitsResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly {
    readonly id: string | null;
    readonly limitCode: string;
    readonly environment: string;
    readonly limitAtomic: string | null;
    readonly limitBps: number | null;
    readonly status: string | null;
    readonly configured: boolean;
  }[];
  readonly breakerEnabled: DomainEnvelope<{ readonly enabled: boolean }>;
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export interface AdminFeatureFlagDto {
  readonly flagKey: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly description: string | null;
  readonly version: number;
  /** Phase 10 baseline: PAYOUT_DISPATCH_PAUSE display is allowed; silent flip is refused. */
  readonly requiresExplicitCeremony: boolean;
}

export interface AdminFeatureFlagsListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly AdminFeatureFlagDto[];
  readonly phase10BaselineNote: string;
}

export interface AdminFeatureFlagMutateRequest {
  readonly flagKey: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly expectedVersion: string;
  readonly confirmationId: string;
}

// ---------------------------------------------------------------------------
// Review queue / Audit / System / Settings / Notifications / Support
// ---------------------------------------------------------------------------

export interface AdminReviewQueueListResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly Record<string, unknown>[];
}

export interface AdminReviewQueueActionRequest {
  readonly action: 'ASSIGN' | 'COMMENT' | 'ESCALATE' | 'RESOLVE_AFTER_DOMAIN';
  readonly reason: string;
  readonly expectedVersion: string;
  readonly note?: string;
  readonly confirmationId: string;
}

export interface AdminAuditLogsResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly items: readonly Record<string, unknown>[];
  readonly appendOnly: true;
}

export interface AdminSystemHealthResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly components: readonly {
    readonly name: string;
    readonly state: 'ok' | 'degraded' | 'unavailable';
    readonly detail?: string;
  }[];
}

export interface AdminSettingsFamiliesResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly families: readonly string[];
  readonly typedOnly: true;
}

export interface AdminNotificationCampaignDraftRequest {
  readonly code: string;
  readonly title: string;
  readonly category: string;
  readonly reason: string;
}

export interface AdminMissionsFoundationResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly status: 'EMPTY' | 'UNAVAILABLE';
  readonly reasonCode: 'ENGINE_NOT_ENABLED';
  readonly data: null;
}

export interface AdminReferralFoundationResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly status: 'UNAVAILABLE';
  readonly reasonCode: 'ENGINE_NOT_ENABLED';
  readonly data: null;
}

/** Safe aggregate counts only — never linked user PII, IP, wallet, or initData. */
export interface AdminFraudSafeAggregateEvidence {
  readonly relatedPayoutAccountCount?: number;
  readonly relatedNetworkAccountCount?: number;
  readonly reversedAdRewardCount?: number;
  readonly rejectedReferralCount?: number;
  readonly signalCodesPresent: readonly string[];
}

export interface AdminFraudRiskProfileView {
  readonly score: number;
  readonly riskTier: string;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly calculatedAt: string;
}

export interface AdminFraudRiskSnapshotMeta {
  readonly id: string;
  readonly decisionScope: string;
  readonly score: number;
  readonly riskTier: string;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly calculatedAt: string;
  readonly safeAggregates: AdminFraudSafeAggregateEvidence;
}

export interface AdminFraudTrustCurrentView {
  readonly trustState: string;
}

export interface AdminFraudTrustSnapshotMeta {
  readonly id: string;
  readonly trustState: string;
  readonly trustScore: number;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly calculatedAt: string;
}

export interface AdminFraudEligibilityDecisionView {
  readonly id: string;
  readonly actionType: string;
  readonly policyVersion: number | null;
  readonly outcome: string;
  readonly reasonCodes: readonly string[];
  readonly decidedAt: string;
}

export interface AdminFraudFlagView {
  readonly id: string;
  readonly flagType: string;
  readonly status: string;
  readonly severity: string;
  readonly createdAt: string;
}

export interface AdminFraudReviewCaseView {
  readonly id: string;
  readonly caseType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly priority: string;
  readonly state: string;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** READY evidence envelope for Admin fraud read visibility (Phase 14 Step 14). */
export interface AdminFraudEvidenceData {
  readonly userId: string | null;
  readonly riskProfile: AdminFraudRiskProfileView | null;
  readonly latestRiskSnapshot: AdminFraudRiskSnapshotMeta | null;
  readonly trustCurrent: AdminFraudTrustCurrentView | null;
  readonly latestTrustSnapshot: AdminFraudTrustSnapshotMeta | null;
  readonly recentEligibilityDecisions: readonly AdminFraudEligibilityDecisionView[];
  readonly openOrConfirmedFraudFlags: readonly AdminFraudFlagView[];
  readonly liveFraudReviewCases: readonly AdminFraudReviewCaseView[];
}

export interface AdminFraudReadResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly status: 'READY' | 'EMPTY';
  readonly data: AdminFraudEvidenceData | null;
  readonly errorCode?: 'NO_DATA';
  readonly phase14Engine: {
    readonly status: 'READY';
  };
}

export interface AdminFraudEnsureReviewRequest {
  readonly reason: string;
  readonly expectedVersion: string;
  readonly confirmationId: string;
  readonly summary?: string;
}

export interface AdminFraudEnsureReviewResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly reviewCase: AdminFraudReviewCaseView;
  readonly createdOrReused: 'CREATED' | 'REUSED';
  readonly ledgerWrite: false;
}
