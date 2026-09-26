import type { PoolClient } from 'pg';

import { hardCeilingFor, capabilitiesFromDbRow, countOpenClarifications } from './admin-read.js';
import { withLedgerTransaction, type AdsDb } from './db.js';
import { AdsDomainError } from './errors.js';
import { getProviderHealthOnClient } from './health.js';
import { findDimension, resolveEffectiveProviderLimits } from './limits/resolve.js';
import {
  evaluateProviderMonetaryEligibility,
  type ProviderMonetaryEligibilityResult,
} from './monetary/eligibility.js';
import { utcDayString } from './sessions/authorize.js';
import type {
  AdProviderStatus,
  EnvironmentName,
  ProviderHealth,
  ProviderLimitMetric,
  ProviderMonetaryStatus,
  RiskTier,
} from './types.js';

/**
 * What `usedCount` / `remaining` are measured against.
 *
 * - SERVER_AUTHORIZED_SESSION_CONSERVATIVE — COUNT(ad_sessions) for the UTC day;
 *   matches authorize REQUEST safety (P11-01). Not proven actual provider requests.
 * - AUTHORITATIVE_PROVIDER_REQUEST — ad_daily_counters.provider_requests when an
 *   approved provider-proof write path exists (AdsGram currently has none).
 * - SUCCESSFUL_REWARD — ad_daily_counters.successful_rewards.
 */
export type EarnUsageBasis =
  'SERVER_AUTHORIZED_SESSION_CONSERVATIVE' | 'AUTHORITATIVE_PROVIDER_REQUEST' | 'SUCCESSFUL_REWARD';

export interface EarnLimitUsage {
  readonly metric: ProviderLimitMetric;
  /** False when no ACTIVE versioned rule covers this dimension — no cap is ever invented. */
  readonly configured: boolean;
  readonly maxCount: number | null;
  readonly usedCount: number;
  readonly remaining: number | null;
  readonly decidingRuleId: string | null;
  readonly decidingRuleVersion: number | null;
  readonly usageBasis: EarnUsageBasis;
}

export interface EarnSummaryForUser {
  readonly providerId: string;
  readonly providerCode: string;
  readonly name: string;
  readonly providerStatus: AdProviderStatus;
  readonly rewardedUseAllowed: boolean;
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
  readonly monetary: ProviderMonetaryEligibilityResult;
  readonly health: ProviderHealth;
  readonly utcDay: string;
  readonly asOf: string;
  readonly request: EarnLimitUsage;
  readonly success: EarnLimitUsage;
  /** `ad_units.client_config.blockId` for this environment; null when not configured. */
  readonly blockIdPublic: string | null;
  /**
   * Locators the Mini App may pass to authorize. Null when no ACTIVE AD budget period
   * is publishable for the payout asset — the client must never invent them.
   */
  readonly authorizeAssetId: string | null;
  readonly authorizeBudgetPeriodId: string | null;
}

export interface GetEarnSummaryForUserInput {
  readonly providerCode: string;
  readonly userId: string;
  readonly environment: EnvironmentName;
  readonly asOf?: Date;
  /** Payout asset network — used only to publish authorize locators. */
  readonly networkCode?: string;
  /** Payout asset symbol — used only to publish authorize locators. */
  readonly assetSymbol?: string;
}

interface ProviderRow {
  id: string;
  code: string;
  name: string;
  status: AdProviderStatus;
  production_monetary_status: ProviderMonetaryStatus;
  rewarded_use_allowed: boolean;
  capabilities: Record<string, unknown>;
}

/**
 * User-facing earn summary for one provider.
 *
 * This is the mini app's view, not the Owner/admin view: it reports the monetary gate
 * decision and the remaining opportunities against the ACTIVE versioned limit rules, and
 * deliberately carries no credentials, no `server_config`, no revenue figures and no
 * clarification detail. A BLOCKED provider is reported as BLOCKED — the read never softens
 * it, and reading this summary never authorizes a session or moves money.
 */
export async function getEarnSummaryForUser(
  db: AdsDb,
  input: GetEarnSummaryForUserInput,
): Promise<EarnSummaryForUser> {
  return withLedgerTransaction(db, (client) => getEarnSummaryOnClient(client, input));
}

async function getEarnSummaryOnClient(
  client: PoolClient,
  input: GetEarnSummaryForUserInput,
): Promise<EarnSummaryForUser> {
  const asOf = input.asOf ?? new Date();

  const providerResult = await client.query<ProviderRow>(
    `SELECT id,
            code,
            name,
            status::text AS status,
            production_monetary_status::text AS production_monetary_status,
            rewarded_use_allowed,
            capabilities
     FROM ad_providers
     WHERE code = $1`,
    [input.providerCode],
  );
  const provider = providerResult.rows[0];
  if (provider === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_FOUND', 'provider not found', {
      details: { providerCode: input.providerCode },
    });
  }

  const userResult = await client.query<{ risk_tier: RiskTier; country_code: string | null }>(
    `SELECT risk_tier::text AS risk_tier, country_code FROM users WHERE id = $1::uuid`,
    [input.userId],
  );
  const user = userResult.rows[0];
  if (user === undefined) {
    throw new AdsDomainError('VALIDATION', 'user not found', { details: { userId: input.userId } });
  }

  const capabilities = capabilitiesFromDbRow(
    provider.capabilities,
    provider.production_monetary_status,
  );
  const health = await getProviderHealthOnClient(client, provider.id);
  const openClarificationCount = await countOpenClarifications(client, provider.id);

  const limits = await resolveEffectiveProviderLimits(client, {
    providerId: provider.id,
    asOf,
    countryCode: user.country_code,
    riskTier: user.risk_tier,
  });

  const utcDay = utcDayString(asOf);
  const counters = await client.query<{
    successful_rewards: number;
  }>(
    `SELECT successful_rewards
     FROM ad_daily_counters
     WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date`,
    [input.userId, provider.id, utcDay],
  );
  const successfulRewards = counters.rows[0]?.successful_rewards ?? 0;

  // P11-01: REQUEST remaining must match authorize's conservative session cap.
  // AdsGram has no approved authoritative provider_requests write path; do not
  // present provider_requests as user-facing request usage.
  const sessionCountResult = await client.query<{ session_count: string }>(
    `SELECT COUNT(*)::text AS session_count
     FROM ad_sessions
     WHERE user_id = $1::uuid
       AND provider_id = $2::uuid
       AND utc_day = $3::date`,
    [input.userId, provider.id, utcDay],
  );
  const authorizedSessionCount = Number(sessionCountResult.rows[0]?.session_count ?? 0);

  const request = toLimitUsage(
    'REQUEST',
    limits,
    authorizedSessionCount,
    'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
  );
  const success = toLimitUsage('SUCCESS', limits, successfulRewards, 'SUCCESSFUL_REWARD');

  const requestCeiling = hardCeilingFor(limits, 'REQUEST');
  const successCeiling = hardCeilingFor(limits, 'SUCCESS');

  const monetary = evaluateProviderMonetaryEligibility({
    providerId: provider.id,
    providerCode: provider.code,
    productionMonetaryStatus: provider.production_monetary_status,
    cashRewardPolicyApproved: capabilities.cashRewardPolicyApproved,
    serverSignalAuthentication: capabilities.serverSignalAuthentication,
    sessionOrImpressionCorrelation: capabilities.sessionOrImpressionCorrelation,
    health: health.status,
    openClarificationCount,
    requestHardLimitExceeded: requestCeiling !== null && authorizedSessionCount >= requestCeiling,
    successHardLimitExceeded: successCeiling !== null && successfulRewards >= successCeiling,
  });

  const blockIdPublic = await readPublicBlockId(client, provider.id, input.environment);
  const locators = await readAuthorizeLocators(client, {
    networkCode: input.networkCode,
    assetSymbol: input.assetSymbol,
    asOf,
  });

  return {
    providerId: provider.id,
    providerCode: provider.code,
    name: provider.name,
    providerStatus: provider.status,
    rewardedUseAllowed: provider.rewarded_use_allowed,
    productionMonetaryStatus: provider.production_monetary_status,
    monetary,
    health,
    utcDay,
    asOf: asOf.toISOString(),
    request,
    success,
    blockIdPublic,
    authorizeAssetId: locators.assetId,
    authorizeBudgetPeriodId: locators.budgetPeriodId,
  };
}

function toLimitUsage(
  metric: ProviderLimitMetric,
  limits: Awaited<ReturnType<typeof resolveEffectiveProviderLimits>>,
  usedCount: number,
  usageBasis: EarnUsageBasis,
): EarnLimitUsage {
  const dimension = findDimension(limits.byDimension, metric, 'UTC_DAY');
  if (dimension === null) {
    return {
      metric,
      configured: false,
      maxCount: null,
      usedCount,
      remaining: null,
      decidingRuleId: null,
      decidingRuleVersion: null,
      usageBasis,
    };
  }
  return {
    metric,
    configured: true,
    maxCount: dimension.maxCount,
    usedCount,
    remaining: Math.max(0, dimension.maxCount - usedCount),
    decidingRuleId: dimension.decidingRule.ruleId,
    decidingRuleVersion: dimension.decidingRule.ruleVersion,
    usageBasis,
  };
}

/**
 * Public SDK block id only.
 *
 * `client_config` is the one column the schema designates as client-safe; `server_config`
 * is never read here, so a secret placed in the wrong column still cannot leak through
 * this endpoint.
 */
async function readPublicBlockId(
  client: PoolClient,
  providerId: string,
  environment: EnvironmentName,
): Promise<string | null> {
  const result = await client.query<{ block_id: string | null }>(
    `SELECT client_config->>'blockId' AS block_id
     FROM ad_units
     WHERE provider_id = $1::uuid
       AND environment = $2::environment_name
       AND status = 'ACTIVE'
       AND format = 'REWARDED_VIDEO'
     ORDER BY placement_code
     LIMIT 1`,
    [providerId, environment],
  );
  const blockId = result.rows[0]?.block_id ?? null;
  return blockId === null || blockId.trim() === '' ? null : blockId;
}

/**
 * Publish authorize locators for the Mini App.
 *
 * The client must never invent an asset or budget period. When no ACTIVE GLOBAL
 * UTC_DAY budget covers `asOf` for the payout asset, both fields stay null.
 */
async function readAuthorizeLocators(
  client: PoolClient,
  input: {
    readonly networkCode: string | undefined;
    readonly assetSymbol: string | undefined;
    readonly asOf: Date;
  },
): Promise<{ readonly assetId: string | null; readonly budgetPeriodId: string | null }> {
  const networkCode = input.networkCode?.trim() ?? '';
  const assetSymbol = input.assetSymbol?.trim() ?? '';
  if (networkCode === '' || assetSymbol === '') {
    return { assetId: null, budgetPeriodId: null };
  }

  const asset = await client.query<{ id: string }>(
    `SELECT a.id
     FROM assets a
     INNER JOIN networks n ON n.id = a.network_id
     WHERE n.code = $1 AND a.symbol = $2 AND a.status = 'ACTIVE'
     LIMIT 1`,
    [networkCode, assetSymbol],
  );
  const assetId = asset.rows[0]?.id ?? null;
  if (assetId === null) {
    return { assetId: null, budgetPeriodId: null };
  }

  const budget = await client.query<{ id: string }>(
    `SELECT id
     FROM reward_budget_periods
     WHERE asset_id = $1::uuid
       AND scope_type = 'GLOBAL'
       AND granularity = 'UTC_DAY'
       AND status = 'ACTIVE'
       AND period_start <= $2::timestamptz
       AND period_end > $2::timestamptz
     ORDER BY period_start DESC
     LIMIT 1`,
    [assetId, input.asOf.toISOString()],
  );
  return { assetId, budgetPeriodId: budget.rows[0]?.id ?? null };
}
