import type {
  EarnSummaryResponse,
  HomeLatestWithdrawalData,
  HomeMissionsData,
  HomeSummaryResponse,
  HomeTodayAdsData,
} from '@alex-rewards/contracts';

import type { HomeWalletCtaKind } from './home-wallet-cta';

export type HomeSmartActionKind =
  | 'wallet_verification'
  | 'claimable_task'
  | 'active_withdrawal'
  | 'earn_opportunity';

export interface HomeSmartActionModel {
  readonly kind: HomeSmartActionKind;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly href: '/wallet' | '/tasks' | '/earn';
  /** Optional server state for withdrawal label interpolation. */
  readonly withdrawalState?: string;
}

/** Non-terminal / attention withdrawal states for Smart Action. */
export const HOME_SMART_ACTION_WITHDRAWAL_STATES = new Set([
  'REQUESTED',
  'RISK_CHECK',
  'MANUAL_REVIEW',
  'APPROVED',
  'QUEUED',
  'SIGNING',
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'HELD',
  'FAILED_PRE_BROADCAST',
  'RECONCILE_REQUIRED',
]);

export const HOME_SMART_ACTION_TERMINAL_WITHDRAWAL_STATES = new Set(['CONFIRMED', 'REJECTED']);

function hasClaimableMission(missions: HomeSummaryResponse['missions']): boolean {
  if (missions.status !== 'READY' || missions.data === null) return false;
  const data: HomeMissionsData = missions.data;
  return data.claimableCount > 0;
}

function activeWithdrawal(
  latest: HomeSummaryResponse['latestWithdrawal'],
): HomeLatestWithdrawalData | null {
  if (latest.status !== 'READY' || latest.data === null) return null;
  const state = latest.data.state;
  if (HOME_SMART_ACTION_TERMINAL_WITHDRAWAL_STATES.has(state)) return null;
  if (!HOME_SMART_ACTION_WITHDRAWAL_STATES.has(state)) return null;
  return latest.data;
}

/**
 * Earn Smart Action only when server policy supports a real monetary opportunity.
 * BLOCKED / ineligible AdsGram must not produce attractive monetary CTAs.
 */
export function isEarnOpportunityEligible(input: {
  readonly todayAds: HomeSummaryResponse['todayAds'];
  readonly earnSummary: EarnSummaryResponse | null | undefined;
}): boolean {
  const today = input.todayAds;
  if (today.status !== 'READY' || today.data === null) return false;
  const todayData: HomeTodayAdsData = today.data;
  if (!todayData.monetaryEligible) return false;

  const earn = input.earnSummary;
  if (earn === null || earn === undefined || earn.status !== 'READY') return false;
  const provider = earn.providers.find((p) => p.providerCode === todayData.providerCode);
  if (provider === undefined) return false;
  if (!provider.rewardedUseAllowed) return false;
  if (provider.health.status === 'UNAVAILABLE' || provider.health.status === 'SUSPENDED') {
    return false;
  }
  if (!provider.monetaryEligible) return false;
  if (
    provider.productionMonetaryStatus === 'BLOCKED' ||
    provider.productionMonetaryStatus === 'SUSPENDED'
  ) {
    return false;
  }
  if (
    provider.productionMonetaryStatus !== 'APPROVED' &&
    provider.productionMonetaryStatus !== 'TEST_ONLY'
  ) {
    return false;
  }

  const request = provider.opportunitiesRemaining.request;
  const success = provider.opportunitiesRemaining.success;
  if (request.configured && request.remaining !== null && request.remaining <= 0) return false;
  if (success.configured && success.remaining !== null && success.remaining <= 0) return false;

  if (todayData.requestRemaining !== null && todayData.requestRemaining <= 0) return false;
  if (todayData.successRemaining !== null && todayData.successRemaining <= 0) return false;

  return true;
}

/**
 * Derive at most one Home Smart Action from server models.
 *
 * Priority: wallet verification → claimable task → active withdrawal → earn → hide.
 * Wallet verification is suppressed when Balance Hero CTA is already `connect`
 * (avoids duplicate adjacent CTAs). With current CTA mapping, unverified wallets
 * always use `connect`, so priority-1 never emits until a future layout diverges.
 */
export function deriveHomeSmartAction(input: {
  readonly home: HomeSummaryResponse;
  readonly walletCtaKind: HomeWalletCtaKind;
  readonly earnSummary: EarnSummaryResponse | null | undefined;
  /**
   * Explicit verification-required signal for future layouts.
   * Ignored when `walletCtaKind === 'connect'` (duplicate suppression).
   */
  readonly walletVerificationRequired?: boolean;
}): HomeSmartActionModel | null {
  const { home, walletCtaKind, earnSummary } = input;
  const walletVerificationRequired = input.walletVerificationRequired === true;

  // 1. Wallet verification — suppress when Balance Hero already shows Connect Wallet.
  if (walletVerificationRequired && walletCtaKind !== 'connect') {
    return {
      kind: 'wallet_verification',
      titleKey: 'smartWalletTitle',
      bodyKey: 'smartWalletBody',
      href: '/wallet',
    };
  }

  // 2. Claimable task (ENGINE_NOT_ENABLED / no claimable → skip)
  if (hasClaimableMission(home.missions)) {
    return {
      kind: 'claimable_task',
      titleKey: 'smartTaskTitle',
      bodyKey: 'smartTaskBody',
      href: '/tasks',
    };
  }

  // 3. Active withdrawal
  const withdrawal = activeWithdrawal(home.latestWithdrawal);
  if (withdrawal !== null) {
    return {
      kind: 'active_withdrawal',
      titleKey: 'smartWithdrawalTitle',
      bodyKey: 'smartWithdrawalBody',
      href: '/wallet',
      withdrawalState: withdrawal.state,
    };
  }

  // 4. Earn opportunity (policy-aware; BLOCKED suppressed)
  if (isEarnOpportunityEligible({ todayAds: home.todayAds, earnSummary })) {
    return {
      kind: 'earn_opportunity',
      titleKey: 'smartEarnTitle',
      bodyKey: 'smartEarnBody',
      href: '/earn',
    };
  }

  // 5. Hide
  return null;
}
