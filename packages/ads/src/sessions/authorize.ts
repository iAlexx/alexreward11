import { randomUUID } from 'node:crypto';

import { createRewardQuote } from '@alex-rewards/rewards';
import type { PoolClient } from 'pg';

import { DEFAULT_AD_SESSION_TTL_SECONDS, LIVE_AD_SESSION_STATES } from '../constants.js';
import { withLedgerTransaction, type AdsDb } from '../db.js';
import { AdsDomainError } from '../errors.js';
import { requireDimension, resolveEffectiveProviderLimits } from '../limits/resolve.js';
import { getProvider } from '../provider-sdk/registry.js';
import type {
  AdProviderStatus,
  AuthorizeAdInput,
  AuthorizeAdResult,
  ProviderHealthStatus,
  ProviderMonetaryStatus,
  RiskTier,
} from '../types.js';

import { appendAdSessionSignal } from './signals.js';

export interface AuthorizeRewardedAdSessionInput extends AuthorizeAdInput {
  readonly providerCode: string;
}

/** PostgreSQL unique_violation — raised by the one-live-session partial unique index. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export function utcDayString(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

/**
 * Authorize one rewarded ad attempt.
 *
 * The caller has already authenticated the user. This command resolves the provider from
 * the compile-time registry, resolves the effective versioned limits, checks authoritative
 * daily counters and provider health, then creates the ad session and its reward quote in
 * ONE transaction with pre-generated ids (Spec V1.3 §21.3): `reward_quotes.ad_session_id`
 * is the authoritative FK and `ad_sessions.reward_quote_id` is written as a mirror.
 *
 * No money is created here. A quote is a priced promise backed by a budget reservation.
 */
export async function authorizeRewardedAdSession(
  db: AdsDb,
  input: AuthorizeRewardedAdSessionInput,
): Promise<AuthorizeAdResult> {
  const provider = getProvider(input.providerCode);
  return withLedgerTransaction(db, (client) => authorizeOnClient(client, provider.code, input));
}

interface ProviderRow {
  id: string;
  code: string;
  status: AdProviderStatus;
  production_monetary_status: ProviderMonetaryStatus;
  rewarded_use_allowed: boolean;
}

interface UserRow {
  status: string;
  risk_tier: RiskTier;
  country_code: string | null;
}

async function authorizeOnClient(
  client: PoolClient,
  providerCode: string,
  input: AuthorizeRewardedAdSessionInput,
): Promise<AuthorizeAdResult> {
  const asOf = input.asOf ?? new Date();
  const ttlSeconds =
    input.sessionTtlSeconds !== undefined && input.sessionTtlSeconds > 0
      ? input.sessionTtlSeconds
      : DEFAULT_AD_SESSION_TTL_SECONDS;
  const expiresAt = new Date(asOf.getTime() + ttlSeconds * 1000);

  if (input.budgetPeriodId.trim() === '') {
    throw new AdsDomainError('VALIDATION', 'budgetPeriodId is required for ad session quoting');
  }

  const providerResult = await client.query<ProviderRow>(
    `SELECT id,
            code,
            status::text AS status,
            production_monetary_status::text AS production_monetary_status,
            rewarded_use_allowed
     FROM ad_providers
     WHERE code = $1`,
    [providerCode],
  );
  const providerRow = providerResult.rows[0];
  if (providerRow === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_FOUND', 'provider is not configured in the database', {
      details: { providerCode },
    });
  }
  if (providerRow.status !== 'ACTIVE') {
    throw new AdsDomainError('PROVIDER_DISABLED', 'provider is not accepting traffic', {
      details: { providerCode, status: providerRow.status },
    });
  }
  if (!providerRow.rewarded_use_allowed) {
    throw new AdsDomainError('PROVIDER_DISABLED', 'provider is not approved for rewarded use', {
      details: { providerCode },
    });
  }

  const userResult = await client.query<UserRow>(
    `SELECT status::text AS status, risk_tier::text AS risk_tier, country_code
     FROM users
     WHERE id = $1::uuid`,
    [input.userId],
  );
  const userRow = userResult.rows[0];
  if (userRow === undefined) {
    throw new AdsDomainError('VALIDATION', 'user not found', { details: { userId: input.userId } });
  }
  if (userRow.status !== 'ACTIVE') {
    throw new AdsDomainError('VALIDATION', 'user is not active', {
      details: { status: userRow.status },
    });
  }

  const countryCode = input.countryCode ?? userRow.country_code;
  const riskTier = input.riskTier ?? userRow.risk_tier;

  const health = await readLatestHealthStatus(client, providerRow.id);
  if (health === 'UNAVAILABLE' || health === 'SUSPENDED') {
    throw new AdsDomainError('PROVIDER_UNHEALTHY', 'provider health blocks new sessions', {
      details: { providerCode, health },
    });
  }

  const limits = await resolveEffectiveProviderLimits(client, {
    providerId: providerRow.id,
    asOf,
    countryCode,
    riskTier,
  });
  const requestLimit = requireDimension(limits, 'REQUEST', 'UTC_DAY');
  const successLimit = requireDimension(limits, 'SUCCESS', 'UTC_DAY');

  const utcDay = utcDayString(asOf);

  // Serialization point for conservative authorize safety (P11-01).
  // A bare SELECT … FOR UPDATE locks nothing when the row is missing — insert first.
  // provider_requests stays 0 here: it is authoritative actual-provider-request count only,
  // not server-authorized session usage. AdsGram has no approved request-proof path yet.
  await client.query(
    `INSERT INTO ad_daily_counters (
       user_id, provider_id, utc_day, provider_requests, successful_rewards
     ) VALUES ($1::uuid, $2::uuid, $3::date, 0, 0)
     ON CONFLICT (user_id, provider_id, utc_day) DO NOTHING`,
    [input.userId, providerRow.id, utcDay],
  );
  const counters = await client.query<{ provider_requests: number; successful_rewards: number }>(
    `SELECT provider_requests, successful_rewards
     FROM ad_daily_counters
     WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date
     FOR UPDATE`,
    [input.userId, providerRow.id, utcDay],
  );
  const successfulRewards = counters.rows[0]?.successful_rewards ?? 0;

  // Conservative REQUEST safety: count server-created sessions for this UTC day.
  // Distinct from authoritative provider_requests (must not be incremented here).
  const sessionCountResult = await client.query<{ session_count: string }>(
    `SELECT COUNT(*)::text AS session_count
     FROM ad_sessions
     WHERE user_id = $1::uuid
       AND provider_id = $2::uuid
       AND utc_day = $3::date`,
    [input.userId, providerRow.id, utcDay],
  );
  const authorizedSessionCount = Number(sessionCountResult.rows[0]?.session_count ?? 0);
  if (authorizedSessionCount >= requestLimit.maxCount) {
    throw new AdsDomainError('REQUEST_LIMIT_REACHED', 'daily provider request limit reached', {
      details: {
        utcDay,
        authorizedSessionCount,
        maxCount: requestLimit.maxCount,
        decidingRuleId: requestLimit.decidingRule.ruleId,
        metric: 'CONSERVATIVE_AUTHORIZED_SESSIONS',
      },
    });
  }
  if (successfulRewards >= successLimit.maxCount) {
    throw new AdsDomainError('SUCCESS_LIMIT_REACHED', 'daily successful reward limit reached', {
      details: {
        utcDay,
        successfulRewards,
        maxCount: successLimit.maxCount,
        decidingRuleId: successLimit.decidingRule.ruleId,
      },
    });
  }

  const live = await client.query<{ id: string; state: string }>(
    `SELECT id, state::text AS state
     FROM ad_sessions
     WHERE user_id = $1::uuid
       AND provider_id = $2::uuid
       AND state = ANY ($3::ad_session_state[])
     FOR UPDATE`,
    [input.userId, providerRow.id, LIVE_AD_SESSION_STATES],
  );
  const liveRow = live.rows[0];
  if (liveRow !== undefined) {
    throw new AdsDomainError('SESSION_ALREADY_ACTIVE', 'a live ad session already exists', {
      details: { adSessionId: liveRow.id, state: liveRow.state },
    });
  }

  // Pre-generated in one transaction so quote ↔ session identity never races (§21.3).
  const adSessionId = randomUUID();
  const rewardQuoteId = randomUUID();

  try {
    await client.query(
      `INSERT INTO ad_sessions (
         id, user_id, provider_id, ad_unit_id, reward_quote_id, state, utc_day,
         country_code, expires_at, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'CREATED', $5::date,
         $6, $7::timestamptz, $8::timestamptz
       )`,
      [
        adSessionId,
        input.userId,
        providerRow.id,
        input.adUnitId ?? null,
        utcDay,
        countryCode,
        expiresAt.toISOString(),
        asOf.toISOString(),
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdsDomainError(
        'SESSION_ALREADY_ACTIVE',
        'a live ad session already exists for this user and provider',
        { cause: error, details: { providerCode } },
      );
    }
    throw error;
  }

  await appendAdSessionSignal(client, {
    adSessionId,
    source: 'SYSTEM',
    signalType: 'SESSION_CREATED',
    occurredAt: asOf,
    correlation: 'CORRELATED',
    safePayload: { utcDay, providerCode },
  });

  // The Reward Engine is the only module that prices a reward.
  const quote = await createRewardQuote(client, {
    userId: input.userId,
    assetId: input.assetId,
    sourceType: 'AD',
    sourceId: adSessionId,
    providerId: providerRow.id,
    adUnitId: input.adUnitId ?? null,
    countryGroup: input.countryGroup ?? null,
    asOf,
    environment: input.environment ?? 'LOCAL',
    evaluateMembershipBonus: input.evaluateMembershipBonus === true,
    bonusUnavailablePolicy: input.bonusUnavailablePolicy ?? null,
    budgetPeriodId: input.budgetPeriodId,
    membershipBonusBudgetPeriodId: input.membershipBonusBudgetPeriodId ?? null,
    quoteId: rewardQuoteId,
    adSessionId,
  });

  if (quote.quoteId !== rewardQuoteId) {
    throw new AdsDomainError('INTERNAL', 'Reward Engine ignored the pre-generated quote id', {
      details: { expected: rewardQuoteId, actual: quote.quoteId },
    });
  }

  await client.query(
    `UPDATE ad_sessions
     SET reward_quote_id = $2::uuid, state = 'QUOTED', updated_at = now()
     WHERE id = $1::uuid`,
    [adSessionId, rewardQuoteId],
  );
  await appendAdSessionSignal(client, {
    adSessionId,
    source: 'SYSTEM',
    signalType: 'QUOTE_COMMITTED',
    occurredAt: asOf,
    correlation: 'CORRELATED',
    safePayload: { rewardQuoteId, amountAtomic: quote.amountAtomic },
  });

  await client.query(
    `UPDATE ad_sessions
     SET state = 'AUTHORIZED', updated_at = now()
     WHERE id = $1::uuid`,
    [adSessionId],
  );
  await appendAdSessionSignal(client, {
    adSessionId,
    source: 'SYSTEM',
    signalType: 'AUTHORIZATION_PASSED',
    occurredAt: asOf,
    correlation: 'CORRELATED',
    // Immutable historical policy evidence — do not recompute from later ACTIVE rules.
    safePayload: {
      effectiveRequestLimit: requestLimit.maxCount,
      effectiveSuccessLimit: successLimit.maxCount,
      requestLimitRuleId: requestLimit.decidingRule.ruleId,
      requestLimitRuleVersion: requestLimit.decidingRule.ruleVersion,
      requestLimitMetric: requestLimit.metric,
      requestLimitWindow: requestLimit.window,
      requestLimitScope: requestLimit.decidingRule.limitScope,
      successLimitRuleId: successLimit.decidingRule.ruleId,
      successLimitRuleVersion: successLimit.decidingRule.ruleVersion,
      successLimitMetric: successLimit.metric,
      successLimitWindow: successLimit.window,
      successLimitScope: successLimit.decidingRule.limitScope,
      conservativeAuthorizedSessionCountBefore: authorizedSessionCount,
    },
  });

  return {
    adSessionId,
    rewardQuoteId,
    providerId: providerRow.id,
    providerCode: providerRow.code,
    state: 'AUTHORIZED',
    expiresAt: expiresAt.toISOString(),
    quotedAmountAtomic: quote.amountAtomic,
    baseAmountAtomic: quote.baseAmountAtomic,
    membershipBonusAmountAtomic: quote.membershipBonusAmountAtomic,
    effectiveRequestLimit: requestLimit.maxCount,
    effectiveSuccessLimit: successLimit.maxCount,
    limitRuleVersions: limits.ruleVersions,
  };
}

export async function readLatestHealthStatus(
  client: PoolClient,
  providerId: string,
): Promise<ProviderHealthStatus> {
  const result = await client.query<{ status: ProviderHealthStatus }>(
    `SELECT status::text AS status
     FROM provider_health_snapshots
     WHERE provider_id = $1::uuid
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [providerId],
  );
  // No observation recorded yet is not an implicit "healthy".
  return result.rows[0]?.status ?? 'UNAVAILABLE';
}
