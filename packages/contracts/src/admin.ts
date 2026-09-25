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
 * Confirmation binding for high-impact Admin mutations.
 * Binds action + resource + expectedVersion + expiry. Any change to the bound
 * payload invalidates the confirmation (hash mismatch).
 */
export interface HighImpactConfirmationBinding {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly expiresAt: string;
  /** Canonical JSON of the mutation payload that was confirmed. */
  readonly payloadCanonical: string;
  /** SHA-256 hex of the confirmation material. */
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

/** Build a high-impact confirmation binding. Call at confirmation time. */
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
 * Validate a previously issued confirmation against the mutation about to execute.
 * Invalidates when the payload changes, version drifts, action/resource mismatch, or expiry.
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
  readonly confirmation?: HighImpactConfirmationBinding;
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
  readonly confirmation?: HighImpactConfirmationBinding;
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
  readonly confirmation?: HighImpactConfirmationBinding;
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
  readonly confirmation?: HighImpactConfirmationBinding;
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
  readonly confirmation?: HighImpactConfirmationBinding;
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
// Economics / Exposure
// ---------------------------------------------------------------------------

export interface AdminEconomicsAmountDto {
  readonly kind: 'ESTIMATED' | 'SETTLED';
  readonly amountAtomic: string | null;
  readonly status: AdminAvailabilityLabel;
  readonly reasonCode?: string;
}

export interface AdminEconomicsResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly estimated: AdminEconomicsAmountDto;
  readonly settled: AdminEconomicsAmountDto;
  readonly note: 'estimates_are_not_settled';
}

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
  readonly confirmation?: HighImpactConfirmationBinding;
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
  readonly confirmation?: HighImpactConfirmationBinding;
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

export interface AdminFraudReadResponse {
  readonly contractVersion: typeof ADMIN_API_CONTRACT_VERSION;
  readonly existingRisk: DomainEnvelope<Record<string, unknown>>;
  readonly phase14Engine: {
    readonly status: 'UNAVAILABLE';
    readonly reasonCode: 'ENGINE_NOT_ENABLED';
  };
}
