/**
 * Typed Admin API envelopes. Parallel backends may return these shapes;
 * missing routes surface as UNAVAILABLE — never fabricated zeros.
 */

import type { ServerDomainAvailability } from '@alex-rewards/contracts';

export type AdminUiState = ServerDomainAvailability | 'LOADING' | 'ERROR' | 'DEGRADED';

export interface AdminDomainEnvelope<TData> {
  readonly status: ServerDomainAvailability | 'DEGRADED';
  readonly data: TData | null;
  readonly reasonCode?: string;
  readonly message?: string;
}

export interface AdminListQuery {
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
}

export interface AdminListPage<TItem> {
  readonly items: readonly TItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number | null;
  readonly nextCursor: string | null;
}

export interface AdminSessionResponse {
  readonly adminUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly reauthenticatedAt: string | null;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly roles: readonly string[];
  readonly authSource: 'cookie' | 'bearer';
}

export interface AdminAuthSessionIssued {
  readonly adminUserId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly reauthenticatedAt: string | null;
}

export interface AdminWebAuthnOptionsResponse {
  readonly options: Record<string, unknown>;
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly adminUserId?: string;
  readonly phase?: string;
}

/** Authentication assertion JSON from @simplewebauthn/browser. */
export type AuthenticationResponseJSON = Record<string, unknown>;
export type RegistrationResponseJSON = Record<string, unknown>;

export interface AdminReauthResult {
  readonly adminUserId: string;
  readonly sessionId: string;
  readonly reauthenticatedAt: string;
  readonly reauthMaxAgeMs?: number;
  readonly phase?: string;
}

export interface AdminOverviewSnapshot {
  readonly generatedAt: string | null;
  readonly pendingLiabilitiesAtomic: string | null;
  readonly availableLiabilitiesAtomic: string | null;
  readonly reservedLiabilitiesAtomic: string | null;
  readonly hotWalletUsdtAtomic: string | null;
  readonly openReviewCount: number | null;
  readonly payoutDispatchPaused: boolean | null;
  readonly adsgramMonetaryStatus: string | null;
}

export interface AdminUserListItem {
  readonly userId: string;
  readonly telegramUserId: string | null;
  readonly username: string | null;
  readonly locale: string | null;
  readonly countryCode: string | null;
  readonly pendingAtomic: string | null;
  readonly availableAtomic: string | null;
  readonly reservedAtomic: string | null;
  readonly accountStatus: string | null;
  readonly withdrawalStatus: string | null;
  readonly riskTier: string | null;
  readonly lastActiveAt: string | null;
}

export interface AdminWithdrawalListItem {
  readonly id: string;
  readonly publicId: string;
  readonly userId: string;
  readonly state: string;
  readonly requestedAmountAtomic: string | null;
  readonly feeAmountAtomic: string | null;
  readonly netAmountAtomic: string | null;
  readonly priorityReview: boolean | null;
  readonly createdAt: string | null;
}

export interface AdminHotWalletPublicView {
  readonly address: string | null;
  readonly walletVersion: string | null;
  readonly signerType: string | null;
  readonly usdtAtomic: string | null;
  readonly tonAtomic: string | null;
  readonly lastChainSyncAt: string | null;
  readonly reservedPayoutsAtomic: string | null;
  readonly coverageRatio: string | null;
  readonly status: string | null;
}

export interface AdminAdsProviderStatus {
  readonly providerCode: string;
  readonly displayName: string | null;
  readonly productionMonetaryStatus: string;
  readonly monetaryBlockedReason: string | null;
  readonly canApproveProductionMonetary: boolean;
}

export interface AdminEconomicsSnapshot {
  readonly metrics: readonly {
    readonly metric: string;
    readonly basis: string;
    readonly amountAtomic: string | null;
    readonly status: string;
    readonly reasonCode?: string;
    readonly asOf?: string;
  }[];
  readonly note: string;
}

export interface AdminFeatureFlagItem {
  readonly flagKey: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly description: string | null;
  readonly version: number;
  readonly requiresExplicitCeremony: boolean;
}

export interface AdminFeatureFlagsListData {
  readonly items: readonly AdminFeatureFlagItem[];
  readonly phase10BaselineNote?: string;
  readonly contractVersion?: string;
}

export interface AdminSystemHealthItem {
  readonly component: string;
  readonly status: string | null;
  readonly detail: string | null;
}

export interface AdminSystemHealthComponent {
  readonly component: string;
  readonly state: string;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdminBusinessAlertItem {
  readonly alertClass: string;
  readonly severity: string;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
  readonly financialAuthority: false;
  readonly mutatesLedger: false;
  readonly mutatesWithdrawals: false;
  readonly autoUnpause: false;
}

export interface AdminPayoutDispatchPauseView {
  readonly flagKey: 'PAYOUT_DISPATCH_PAUSE';
  readonly environment: string;
  readonly enabled: boolean | null;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly authoritativeSource: 'feature_flags';
  readonly autoUnpause: false;
}

export interface AdminSystemHealthData {
  readonly components: readonly AdminSystemHealthItem[];
  readonly systemComponents: readonly AdminSystemHealthComponent[];
  readonly alerts: readonly AdminBusinessAlertItem[];
  readonly payoutDispatchPause: AdminPayoutDispatchPauseView;
  readonly financialAuthority: false;
  readonly observedAt: string;
  readonly contractVersion?: string;
}

export interface AdminPolicyRuleSummary {
  readonly family: string;
  readonly version: number | null;
  readonly effectiveAt: string | null;
  readonly status: string | null;
}

export interface AdminFraudSafeAggregateEvidence {
  readonly relatedPayoutAccountCount?: number;
  readonly relatedNetworkAccountCount?: number;
  readonly reversedAdRewardCount?: number;
  readonly rejectedReferralCount?: number;
  readonly signalCodesPresent: readonly string[];
}

export interface AdminFraudEvidenceData {
  readonly userId: string | null;
  readonly riskProfile: {
    readonly score: number;
    readonly riskTier: string;
    readonly ruleVersion: number;
    readonly reasonCodes: readonly string[];
    readonly calculatedAt: string;
  } | null;
  readonly latestRiskSnapshot: {
    readonly id: string;
    readonly decisionScope: string;
    readonly score: number;
    readonly riskTier: string;
    readonly ruleVersion: number;
    readonly reasonCodes: readonly string[];
    readonly calculatedAt: string;
    readonly safeAggregates: AdminFraudSafeAggregateEvidence;
  } | null;
  readonly trustCurrent: { readonly trustState: string } | null;
  readonly latestTrustSnapshot: {
    readonly id: string;
    readonly trustState: string;
    readonly trustScore: number;
    readonly ruleVersion: number;
    readonly reasonCodes: readonly string[];
    readonly calculatedAt: string;
  } | null;
  readonly recentEligibilityDecisions: readonly {
    readonly id: string;
    readonly actionType: string;
    readonly policyVersion: number | null;
    readonly outcome: string;
    readonly reasonCodes: readonly string[];
    readonly decidedAt: string;
  }[];
  readonly openOrConfirmedFraudFlags: readonly {
    readonly id: string;
    readonly flagType: string;
    readonly status: string;
    readonly severity: string;
    readonly createdAt: string;
  }[];
  readonly liveFraudReviewCases: readonly {
    readonly id: string;
    readonly caseType: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly priority: string;
    readonly state: string;
    readonly summary: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
}

export interface AdminDiffField {
  readonly path: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export interface AdminHighImpactPreview {
  readonly actionCode: string;
  readonly title: string;
  readonly diffs: readonly AdminDiffField[];
  readonly payloadDigest: string;
  readonly requiresReason: true;
  readonly requiresReauth: boolean;
  readonly requiresSecondConfirm: boolean;
}
