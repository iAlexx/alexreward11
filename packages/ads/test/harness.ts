/**
 * Shared Phase 11 ad-domain test helpers.
 *
 * Destructive against PHASE11_DATABASE_URL (or PHASE11_ADS_TESTS=1 + DATABASE_URL). The
 * destructive-database guard in `@alex-rewards/db` refuses any name that is not an approved
 * test database, so the operational `alex_rewards` database can never be reset from here.
 *
 * Nothing in this file fabricates financial state. Every fixture is a real row created
 * through the same approved commands and schema the product uses: providers, versioned
 * limit rules, reward rules and budget periods are configuration data, and amounts are
 * always priced by the Reward Engine.
 */
import { randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  createRewardBudgetPeriod,
  createRewardRuleVersion,
  utcDayContaining,
  withLedgerTransaction,
} from '@alex-rewards/rewards';
import { Client, type Pool } from 'pg';

// Importing the package entry point also performs the compile-time AdsGram registration.
import {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  authorizeRewardedAdSession,
  capabilitiesToJson,
  findProvider,
  getProviderHealth,
  normalizeClientSignalType,
  redactSafePayload,
  registerProvider,
} from '../src/index.js';
import type {
  AdsDb,
  AuthorizeAdInput,
  AuthorizeAdResult,
  AvailabilityResult,
  ProviderCapabilities,
  ProviderClientSignal,
  ProviderHealth,
  ProviderManifest,
  ProviderVerificationResult,
  RewardedAdProvider,
  VerificationContext,
} from '../src/index.js';

const explicitUrl = process.env.PHASE11_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE11_ADS_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase11DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export { ADSGRAM_CODE, ADSGRAM_PROVIDER_ID };

/** Seeded Phase 11 policy approver from migration 0030. */
export const PHASE11_APPROVER_ADMIN_ID = 'a11a11a1-0000-4000-8000-000000000011';

/** AdsGram limit rule ids seeded by migration 0030 (REQUEST=30, SUCCESS=25). */
export const ADSGRAM_REQUEST_RULE_ID = 'a11a11a1-0000-4000-8000-0000000011a1';
export const ADSGRAM_SUCCESS_RULE_ID = 'a11a11a1-0000-4000-8000-0000000011a2';

/**
 * Certification-only provider used to prove that the monetary gate is provider-neutral.
 *
 * It exists ONLY in this test harness — never in a production migration — because approving
 * a provider for production money is an Owner decision backed by evidence, not something a
 * migration may grant. AdsGram stays BLOCKED.
 */
export const HARNESS_CERT_CODE = 'HARNESS_CERT';
export const HARNESS_CERT_PROVIDER_ID = 'c0de0000-0000-4000-8000-0000000000ce';

export const HARNESS_CERT_CAPABILITIES: ProviderCapabilities = {
  rewarded: true,
  interstitial: false,
  taskAds: false,
  serverRewardCallback: true,
  uniqueProviderEventId: 'SUPPORTED',
  serverSignalAuthentication: 'HMAC_SIGNATURE',
  sessionOrImpressionCorrelation: 'SUPPORTED',
  retryBehaviorDocumented: true,
  deliveryWindowDocumented: true,
  providerSideRequestLimit: 'SUPPORTED',
  countryReporting: true,
  revenueReportingApi: true,
  cashRewardPolicyApproved: true,
  productionMonetaryStatus: 'APPROVED',
};

export async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

let telegramUserIdCounter = 0n;

/** Fresh Telegram identity per call so tests never share a per-user daily counter. */
export function nextTelegramUserId(): string {
  telegramUserIdCounter += 1n;
  return (
    911_000_000_000n +
    BigInt(process.pid % 1000) * 1_000_000n +
    telegramUserIdCounter
  ).toString(10);
}

export async function createTestUser(
  pool: Pool,
  options?: { readonly countryCode?: string | null; readonly riskTier?: string },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale, country_code, risk_tier)
     VALUES ($1::bigint, 'en', $2, COALESCE($3::risk_tier, 'LOW'::risk_tier))
     RETURNING id`,
    [nextTelegramUserId(), options?.countryCode ?? null, options?.riskTier ?? null],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function telegramUserIdOf(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ telegram_user_id: string }>(
    `SELECT telegram_user_id::text AS telegram_user_id FROM users WHERE id = $1::uuid`,
    [userId],
  );
  const value = result.rows[0]?.telegram_user_id;
  if (value === undefined) throw new Error('user not found');
  return value;
}

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('USDT asset missing');
  return id;
}

/**
 * Minimal certification adapter.
 *
 * Unlike the AdsGram adapter it can prove an authenticated, correlated server signal, which
 * is exactly the difference the provider-neutral monetary gate is supposed to notice.
 */
class HarnessCertProvider implements RewardedAdProvider {
  readonly code = HARNESS_CERT_CODE;
  readonly providerId = HARNESS_CERT_PROVIDER_ID;

  getManifest(): ProviderManifest {
    return {
      providerId: HARNESS_CERT_PROVIDER_ID,
      providerCode: HARNESS_CERT_CODE,
      name: 'Certification Harness Provider',
      manifestVersion: 1,
      adapterVersion: '1.0.0-phase11-harness',
      environment: 'LOCAL',
      supportedFormats: ['REWARDED_VIDEO'],
      credentialsReference: null,
      policyStatus: 'HARNESS_ONLY',
      productionMonetaryStatus: 'APPROVED',
      clarificationReference: null,
    };
  }

  getCapabilities(): ProviderCapabilities {
    return HARNESS_CERT_CAPABILITIES;
  }

  async getAvailability(db: AdsDb): Promise<AvailabilityResult> {
    const health = await getProviderHealth(db, this.providerId);
    return {
      available: health.status === 'HEALTHY',
      reasonCodes: health.status === 'HEALTHY' ? [] : ['PROVIDER_HEALTH_NOT_HEALTHY'],
      health: health.status,
      inventoryConfirmed: true,
    };
  }

  async authorizeSession(db: AdsDb, input: AuthorizeAdInput): Promise<AuthorizeAdResult> {
    return authorizeRewardedAdSession(db, { ...input, providerCode: this.code });
  }

  normalizeClientEvent(input: unknown): ProviderClientSignal {
    const source = (input ?? {}) as Record<string, unknown>;
    return {
      signalType: normalizeClientSignalType(source['event']),
      adSessionId: typeof source['adSessionId'] === 'string' ? source['adSessionId'] : null,
      providerEventId: null,
      occurredAt: null,
      safePayload: redactSafePayload(source),
      authenticity: 'UNVERIFIED',
      financialAuthority: false,
    };
  }

  async verifyServerSignal(
    input: unknown,
    context: VerificationContext,
  ): Promise<ProviderVerificationResult> {
    const source = (input ?? {}) as Record<string, unknown>;
    return {
      signalType: 'PROVIDER_CONFIRMATION',
      authenticity: 'VERIFIED',
      authenticationMethod: 'HMAC_SIGNATURE',
      authenticationStrength: 'STRONG',
      correlation: 'CORRELATED',
      providerEventId: typeof source['eventId'] === 'string' ? source['eventId'] : null,
      telegramUserId: typeof source['userid'] === 'string' ? source['userid'] : null,
      occurredAt: context.receivedAt.toISOString(),
      safePayload: redactSafePayload(source),
      reasonCodes: [],
      monetaryAuthority: true,
    };
  }

  async getHealth(db: AdsDb): Promise<ProviderHealth> {
    return getProviderHealth(db, this.providerId);
  }
}

/** Idempotent compile-time registration of the harness adapter. */
export function registerHarnessCertProvider(): RewardedAdProvider {
  return findProvider(HARNESS_CERT_CODE) ?? registerProvider(new HarnessCertProvider());
}

export interface SeedProviderLimitInput {
  readonly providerId: string;
  readonly limitScope:
    'PROVIDER_HARD' | 'CONTRACT' | 'PLATFORM_SOFT' | 'USER_TIER' | 'COUNTRY_OVERRIDE';
  readonly limitMetric: 'REQUEST' | 'SUCCESS';
  readonly limitWindow?: 'HOUR' | 'ROLLING_24H' | 'UTC_DAY';
  readonly maxCount: number;
  readonly ruleVersion?: number;
  readonly validFrom?: Date;
  readonly sourceType?:
    'CONTRACT' | 'OFFICIAL_DOCUMENTATION' | 'WRITTEN_SUPPORT' | 'PROVIDER_ACCOUNT_CONFIG';
  readonly sourceReference?: string;
  readonly ruleId?: string;
}

/** Insert one ACTIVE, approved versioned limit rule. Values are data, never code. */
export async function seedProviderLimitRule(
  pool: Pool,
  input: SeedProviderLimitInput,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO provider_limit_rules (
       id, provider_id, limit_scope, limit_metric, limit_window, max_count, rule_version,
       status, valid_from, source_type, source_reference, reason,
       approved_by_admin_id, approved_at
     ) VALUES (
       COALESCE($1::uuid, app_generate_uuid()), $2::uuid, $3::provider_limit_scope,
       $4::provider_limit_metric, $5::provider_limit_window, $6, $7,
       'ACTIVE', $8::timestamptz, $9::provider_limit_source_type, $10,
       'Phase 11 certification harness limit', $11::uuid, now()
     )
     RETURNING id`,
    [
      input.ruleId ?? null,
      input.providerId,
      input.limitScope,
      input.limitMetric,
      input.limitWindow ?? 'UTC_DAY',
      input.maxCount,
      input.ruleVersion ?? 1,
      (input.validFrom ?? new Date('2024-01-01T00:00:00.000Z')).toISOString(),
      input.sourceType ?? 'OFFICIAL_DOCUMENTATION',
      input.sourceReference ?? 'Phase 11 certification harness',
      PHASE11_APPROVER_ADMIN_ID,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('limit rule insert failed');
  return id;
}

/**
 * Seed the certification-only APPROVED provider with capabilities that satisfy the
 * provider-neutral monetary gate, plus its health observation and limit rules.
 */
export async function seedHarnessCertProvider(
  pool: Pool,
  options?: { readonly requestLimit?: number; readonly successLimit?: number },
): Promise<string> {
  await pool.query(
    `INSERT INTO ad_providers (
       id, code, name, status, lifecycle_state, production_monetary_status,
       capabilities, policy_reference, rewarded_use_allowed, incentivized_crypto_allowed,
       server_verification_supported
     ) VALUES (
       $1::uuid, $2, 'Certification Harness Provider', 'ACTIVE', 'APPROVED', 'APPROVED',
       $3::jsonb, 'test-only certification harness', true, true, true
     )
     ON CONFLICT (code) DO UPDATE SET
       status = EXCLUDED.status,
       lifecycle_state = EXCLUDED.lifecycle_state,
       production_monetary_status = EXCLUDED.production_monetary_status,
       capabilities = EXCLUDED.capabilities,
       rewarded_use_allowed = EXCLUDED.rewarded_use_allowed,
       updated_at = now()`,
    [
      HARNESS_CERT_PROVIDER_ID,
      HARNESS_CERT_CODE,
      JSON.stringify(capabilitiesToJson(HARNESS_CERT_CAPABILITIES)),
    ],
  );

  await setProviderHealthSnapshot(pool, HARNESS_CERT_PROVIDER_ID, 'HEALTHY', 'HARNESS_BASELINE');

  await seedProviderLimitRule(pool, {
    providerId: HARNESS_CERT_PROVIDER_ID,
    limitScope: 'PROVIDER_HARD',
    limitMetric: 'REQUEST',
    maxCount: options?.requestLimit ?? 30,
    sourceType: 'CONTRACT',
  });
  await seedProviderLimitRule(pool, {
    providerId: HARNESS_CERT_PROVIDER_ID,
    limitScope: 'PLATFORM_SOFT',
    limitMetric: 'SUCCESS',
    maxCount: options?.successLimit ?? 25,
  });

  registerHarnessCertProvider();
  return HARNESS_CERT_PROVIDER_ID;
}

export async function setProviderHealthSnapshot(
  pool: Pool,
  providerId: string,
  status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'SUSPENDED',
  reasonCode: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_health_snapshots (provider_id, status, reason_code, observed_at)
     VALUES ($1::uuid, $2::provider_health_status, $3, now())`,
    [providerId, status, reasonCode],
  );
}

/**
 * Create one ACTIVE AD reward rule bound to a provider.
 *
 * Provider-bound so several providers can coexist in one suite without
 * `resolveRewardRule` fail-closing on ambiguity.
 */
export async function createAdRewardRule(
  pool: Pool,
  input: {
    readonly assetId: string;
    readonly providerId: string;
    readonly fixedRewardAtomic?: string;
    readonly pendingHoldSeconds?: number;
    readonly quoteTtlSeconds?: number;
    readonly code?: string;
  },
): Promise<{ readonly ruleId: string; readonly code: string }> {
  return withLedgerTransaction(pool, async (client) => {
    const code = input.code ?? `phase11-ad-${randomUUID().slice(0, 8)}`;
    const rule = await createRewardRuleVersion(client, {
      code,
      sourceType: 'AD',
      assetId: input.assetId,
      providerId: input.providerId,
      fixedRewardAtomic: input.fixedRewardAtomic ?? '1500',
      pendingHoldSeconds: input.pendingHoldSeconds ?? 0,
      quoteTtlSeconds: input.quoteTtlSeconds ?? 900,
      validFrom: new Date(Date.now() - 86_400_000),
      reason: 'Phase 11 certification AD rule',
      activate: true,
    });
    return { ruleId: rule.id, code };
  });
}

/** GLOBAL UTC-day base budget period; authority is re-validated by the Reward Engine. */
export async function createAdBudgetPeriod(
  pool: Pool,
  input: { readonly assetId: string; readonly budgetAtomic?: string; readonly asOf?: Date },
): Promise<string> {
  return withLedgerTransaction(pool, async (client) => {
    const window = utcDayContaining(input.asOf ?? new Date());
    const period = await createRewardBudgetPeriod(client, {
      scopeType: 'GLOBAL',
      assetId: input.assetId,
      granularity: 'UTC_DAY',
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      budgetAtomic: input.budgetAtomic ?? '100000000',
    });
    return period.id;
  });
}

/** Authoritative daily counter state, written the same way the engine writes it. */
export async function setDailyCounters(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly providerId: string;
    readonly utcDay: string;
    readonly providerRequests?: number;
    readonly successfulRewards?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ad_daily_counters (user_id, provider_id, utc_day, provider_requests, successful_rewards)
     VALUES ($1::uuid, $2::uuid, $3::date, $4, $5)
     ON CONFLICT (user_id, provider_id, utc_day) DO UPDATE
       SET provider_requests = EXCLUDED.provider_requests,
           successful_rewards = EXCLUDED.successful_rewards,
           updated_at = now()`,
    [
      input.userId,
      input.providerId,
      input.utcDay,
      input.providerRequests ?? 0,
      input.successfulRewards ?? 0,
    ],
  );
}

export function utcDayString(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

export async function countLedgerTransactions(pool: Pool): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ledger_transactions`,
  );
  return Number(result.rows[0]?.total ?? '0');
}

export async function countLedgerTransactionsForQuote(
  pool: Pool,
  quoteId: string,
): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ledger_transactions WHERE business_reference_id = $1::uuid`,
    [quoteId],
  );
  return Number(result.rows[0]?.total ?? '0');
}

export async function readSessionRow(
  pool: Pool,
  adSessionId: string,
): Promise<{
  readonly state: string;
  readonly rewardQuoteId: string | null;
  readonly successfulRewardCounted: boolean;
  readonly providerRequestCounted: boolean;
  readonly failureCode: string | null;
}> {
  const result = await pool.query<{
    state: string;
    reward_quote_id: string | null;
    successful_reward_counted: boolean;
    provider_request_counted: boolean;
    failure_code: string | null;
  }>(
    `SELECT state::text AS state, reward_quote_id, successful_reward_counted,
            provider_request_counted, failure_code
     FROM ad_sessions WHERE id = $1::uuid`,
    [adSessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('ad session not found');
  return {
    state: row.state,
    rewardQuoteId: row.reward_quote_id,
    successfulRewardCounted: row.successful_reward_counted,
    providerRequestCounted: row.provider_request_counted,
    failureCode: row.failure_code,
  };
}

export async function readQuoteStatus(pool: Pool, quoteId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    `SELECT status::text AS status FROM reward_quotes WHERE id = $1::uuid`,
    [quoteId],
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new Error('reward quote not found');
  return status;
}
