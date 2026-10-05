import type { EarnOpportunityLimitDto, EarnProviderCardDto } from '@alex-rewards/contracts';

export type EarnAttemptBlockReason =
  | 'blocked_monetary'
  | 'monetary_suspended'
  | 'rewarded_use_disallowed'
  | 'health_unavailable'
  | 'health_suspended'
  | 'missing_block_id'
  | 'missing_authorize_locators'
  | 'request_limit'
  | 'success_limit';

export interface EarnAttemptGate {
  readonly canStart: boolean;
  readonly reason: EarnAttemptBlockReason | null;
}

/** Presentational progress only — never used for authorization. */
export function limitProgressPercent(limit: EarnOpportunityLimitDto): number | null {
  if (!limit.configured || limit.maxCount === null || limit.maxCount <= 0) return null;
  const raw = (limit.usedCount / limit.maxCount) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

export function isAtConfiguredLimit(limit: EarnOpportunityLimitDto): boolean {
  return limit.configured && limit.remaining !== null && limit.remaining <= 0;
}

/**
 * Server-truth gate for starting a rewarded attempt.
 * BLOCKED / SUSPENDED / ineligible must not yield an enabled Watch CTA.
 * SUSPENDED is blocked independently of monetaryEligible (defense in depth).
 */
export function resolveEarnAttemptGate(provider: EarnProviderCardDto): EarnAttemptGate {
  if (provider.productionMonetaryStatus === 'SUSPENDED') {
    return { canStart: false, reason: 'monetary_suspended' };
  }
  if (
    provider.productionMonetaryStatus === 'BLOCKED' ||
    provider.monetaryEligible === false
  ) {
    return { canStart: false, reason: 'blocked_monetary' };
  }
  if (!provider.rewardedUseAllowed) {
    return { canStart: false, reason: 'rewarded_use_disallowed' };
  }
  if (provider.health.status === 'UNAVAILABLE') {
    return { canStart: false, reason: 'health_unavailable' };
  }
  if (provider.health.status === 'SUSPENDED') {
    return { canStart: false, reason: 'health_suspended' };
  }
  if (provider.blockIdPublic === null) {
    return { canStart: false, reason: 'missing_block_id' };
  }
  if (provider.authorizeAssetId === null || provider.authorizeBudgetPeriodId === null) {
    return { canStart: false, reason: 'missing_authorize_locators' };
  }
  if (isAtConfiguredLimit(provider.opportunitiesRemaining.request)) {
    return { canStart: false, reason: 'request_limit' };
  }
  if (isAtConfiguredLimit(provider.opportunitiesRemaining.success)) {
    return { canStart: false, reason: 'success_limit' };
  }
  return { canStart: true, reason: null };
}
