import type { EarnLimitUsage, EarnSummaryForUser } from '@alex-rewards/ads';
import type { EarnOpportunityLimitDto, EarnProviderCardDto } from '@alex-rewards/contracts';

function toLimitDto(usage: EarnLimitUsage): EarnOpportunityLimitDto {
  return {
    metric: usage.metric,
    configured: usage.configured,
    maxCount: usage.maxCount,
    usedCount: usage.usedCount,
    remaining: usage.remaining,
    decidingRuleId: usage.decidingRuleId,
    decidingRuleVersion: usage.decidingRuleVersion,
    usageBasis: usage.usageBasis,
  };
}

/**
 * Project the ad domain's earn summary onto the user-facing card.
 *
 * Whitelist by construction: the card is assembled field by field, so a future addition to
 * the domain result (credentials, revenue, clarification detail) cannot reach a client
 * unless someone deliberately adds it here. `monetaryEligible` and `productionMonetaryStatus`
 * are copied unchanged — a BLOCKED provider is never presented as earnable.
 */
export function toEarnProviderCard(summary: EarnSummaryForUser): EarnProviderCardDto {
  return {
    providerCode: summary.providerCode,
    name: summary.name,
    utcDay: summary.utcDay,
    productionMonetaryStatus: summary.productionMonetaryStatus,
    monetaryEligible: summary.monetary.eligible,
    reasonCodes: summary.monetary.reasonCodes,
    health: { status: summary.health.status, observedAt: summary.health.observedAt },
    rewardedUseAllowed: summary.rewardedUseAllowed,
    opportunitiesRemaining: {
      request: toLimitDto(summary.request),
      success: toLimitDto(summary.success),
    },
    blockIdPublic: summary.blockIdPublic,
    authorizeAssetId: summary.authorizeAssetId,
    authorizeBudgetPeriodId: summary.authorizeBudgetPeriodId,
  };
}
