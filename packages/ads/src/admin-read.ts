import type { PoolClient } from 'pg';

import { HARD_LIMIT_SCOPES } from './constants.js';
import { withLedgerTransaction, type AdsDb } from './db.js';
import { AdsDomainError } from './errors.js';
import { getProviderHealthOnClient } from './health.js';
import { resolveEffectiveProviderLimits, type EffectiveProviderLimits } from './limits/resolve.js';
import {
  evaluateProviderMonetaryEligibility,
  type ProviderMonetaryEligibilityResult,
} from './monetary/eligibility.js';
import type { ProviderCapabilities } from './provider-sdk/capabilities.js';
import { findProvider } from './provider-sdk/registry.js';
import type {
  AdProviderStatus,
  CapabilityTriState,
  ProviderClarificationItem,
  ProviderHealth,
  ProviderLifecycleState,
  ProviderMonetaryStatus,
  ProviderSignalAuthentication,
  RiskTier,
} from './types.js';

export interface ProviderAdminView {
  readonly providerId: string;
  readonly providerCode: string;
  readonly name: string;
  readonly status: AdProviderStatus;
  readonly lifecycleState: ProviderLifecycleState;
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
  readonly rewardedUseAllowed: boolean;
  readonly incentivizedCryptoAllowed: boolean;
  readonly policyReference: string | null;
  /** Capabilities as stored in the database (authoritative for the monetary gate). */
  readonly capabilities: ProviderCapabilities;
  /** Capabilities declared by the compile-time adapter, when one is registered. */
  readonly adapterCapabilities: ProviderCapabilities | null;
  readonly adapterRegistered: boolean;
  readonly monetary: ProviderMonetaryEligibilityResult;
  readonly limits: EffectiveProviderLimits;
  readonly health: ProviderHealth;
  readonly clarifications: readonly ProviderClarificationItem[];
  readonly openClarificationCount: number;
}

export interface GetProviderAdminViewInput {
  readonly providerCode: string;
  readonly asOf?: Date;
  readonly countryCode?: string | null;
  readonly riskTier?: RiskTier | null;
}

interface ProviderAdminRow {
  id: string;
  code: string;
  name: string;
  status: AdProviderStatus;
  lifecycle_state: ProviderLifecycleState;
  production_monetary_status: ProviderMonetaryStatus;
  rewarded_use_allowed: boolean;
  incentivized_crypto_allowed: boolean;
  policy_reference: string | null;
  capabilities: Record<string, unknown>;
}

const PROVIDER_ADMIN_COLUMNS = `id,
            code,
            name,
            status::text AS status,
            lifecycle_state::text AS lifecycle_state,
            production_monetary_status::text AS production_monetary_status,
            rewarded_use_allowed,
            incentivized_crypto_allowed,
            policy_reference,
            capabilities`;

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/** `true` → SUPPORTED, `false` → UNSUPPORTED, anything else (including 'UNKNOWN') → UNKNOWN. */
function readTriState(source: Record<string, unknown>, key: string): CapabilityTriState {
  const value = source[key];
  if (value === true) return 'SUPPORTED';
  if (value === false) return 'UNSUPPORTED';
  return 'UNKNOWN';
}

const SIGNAL_AUTHENTICATION_VALUES: readonly ProviderSignalAuthentication[] = [
  'NONE',
  'SHARED_SECRET',
  'HMAC_SIGNATURE',
  'MUTUAL_TLS',
  'IP_ALLOWLIST',
  'OAUTH',
];

function readSignalAuthentication(
  source: Record<string, unknown>,
  key: string,
): ProviderSignalAuthentication {
  const value = source[key];
  return SIGNAL_AUTHENTICATION_VALUES.find((candidate) => candidate === value) ?? 'NONE';
}

const MONETARY_STATUS_VALUES: readonly ProviderMonetaryStatus[] = [
  'BLOCKED',
  'TEST_ONLY',
  'APPROVED',
  'SUSPENDED',
];

/**
 * Project `ad_providers.capabilities` onto the typed capability shape.
 *
 * Unknown or absent values fail closed: missing booleans read as `false`, missing
 * tri-states as `UNKNOWN`, missing authentication as `NONE`. The stored
 * `production_monetary_status` column wins over the JSONB copy.
 */
export function capabilitiesFromDbRow(
  capabilities: Record<string, unknown>,
  productionMonetaryStatus: ProviderMonetaryStatus,
): ProviderCapabilities {
  return {
    rewarded: readBoolean(capabilities, 'rewarded'),
    interstitial: readBoolean(capabilities, 'interstitial'),
    taskAds: readBoolean(capabilities, 'taskAds'),
    serverRewardCallback: readBoolean(capabilities, 'serverRewardCallback'),
    uniqueProviderEventId: readTriState(capabilities, 'uniqueProviderEventId'),
    serverSignalAuthentication: readSignalAuthentication(
      capabilities,
      'serverSignalAuthentication',
    ),
    sessionOrImpressionCorrelation: readTriState(capabilities, 'sessionOrImpressionCorrelation'),
    retryBehaviorDocumented: readBoolean(capabilities, 'retryBehaviorDocumented'),
    deliveryWindowDocumented: readBoolean(capabilities, 'deliveryWindowDocumented'),
    providerSideRequestLimit: readTriState(capabilities, 'providerSideRequestLimit'),
    countryReporting: readBoolean(capabilities, 'countryReporting'),
    revenueReportingApi: readBoolean(capabilities, 'revenueReportingApi'),
    cashRewardPolicyApproved: readBoolean(capabilities, 'cashRewardPolicyApproved'),
    productionMonetaryStatus:
      MONETARY_STATUS_VALUES.find(
        (candidate) => candidate === capabilities['productionMonetaryStatus'],
      ) ?? productionMonetaryStatus,
  };
}

export interface ProviderMonetaryFacts {
  readonly providerId: string;
  readonly providerCode: string;
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
  readonly capabilities: ProviderCapabilities;
  readonly health: ProviderHealth;
  readonly openClarificationCount: number;
}

/**
 * Load every database-sourced fact the monetary gate needs. Nothing here is
 * provider-specific: the same read serves any registered adapter.
 */
export async function loadProviderMonetaryFacts(
  client: PoolClient,
  providerId: string,
): Promise<ProviderMonetaryFacts> {
  const result = await client.query<ProviderAdminRow>(
    `SELECT ${PROVIDER_ADMIN_COLUMNS} FROM ad_providers WHERE id = $1::uuid`,
    [providerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_FOUND', 'provider not found', {
      details: { providerId },
    });
  }
  const health = await getProviderHealthOnClient(client, providerId);
  const openClarificationCount = await countOpenClarifications(client, providerId);
  return {
    providerId: row.id,
    providerCode: row.code,
    productionMonetaryStatus: row.production_monetary_status,
    capabilities: capabilitiesFromDbRow(row.capabilities, row.production_monetary_status),
    health,
    openClarificationCount,
  };
}

export async function countOpenClarifications(
  client: PoolClient,
  providerId: string,
): Promise<number> {
  const result = await client.query<{ open_count: number }>(
    `SELECT count(*)::int AS open_count
     FROM provider_clarification_items
     WHERE provider_id = $1::uuid AND status = 'OPEN'`,
    [providerId],
  );
  return result.rows[0]?.open_count ?? 0;
}

export async function listProviderClarifications(
  client: PoolClient,
  providerId: string,
): Promise<readonly ProviderClarificationItem[]> {
  const result = await client.query<{
    id: string;
    item_code: string;
    title: string;
    status: ProviderClarificationItem['status'];
    detail: string;
    evidence_reference: string | null;
    updated_at: Date;
  }>(
    `SELECT id, item_code, title, status, detail, evidence_reference, updated_at
     FROM provider_clarification_items
     WHERE provider_id = $1::uuid
     ORDER BY status, item_code`,
    [providerId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    itemCode: row.item_code,
    title: row.title,
    status: row.status,
    detail: row.detail,
    evidenceReference: row.evidence_reference,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Read-only Owner/admin view of one provider: policy status, monetary gate decision with
 * reason codes, declared capabilities, ACTIVE limit rule versions, latest health and the
 * clarification register. Implementation completeness is deliberately shown separately
 * from production-money approval.
 */
export async function getProviderAdminView(
  db: AdsDb,
  input: GetProviderAdminViewInput,
): Promise<ProviderAdminView> {
  return withLedgerTransaction(db, (client) => getProviderAdminViewOnClient(client, input));
}

async function getProviderAdminViewOnClient(
  client: PoolClient,
  input: GetProviderAdminViewInput,
): Promise<ProviderAdminView> {
  const asOf = input.asOf ?? new Date();
  const result = await client.query<ProviderAdminRow>(
    `SELECT ${PROVIDER_ADMIN_COLUMNS} FROM ad_providers WHERE code = $1`,
    [input.providerCode],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_FOUND', 'provider not found', {
      details: { providerCode: input.providerCode },
    });
  }

  const capabilities = capabilitiesFromDbRow(row.capabilities, row.production_monetary_status);
  const health = await getProviderHealthOnClient(client, row.id);
  const clarifications = await listProviderClarifications(client, row.id);
  const openClarificationCount = clarifications.filter((item) => item.status === 'OPEN').length;

  const limits = await resolveEffectiveProviderLimits(client, {
    providerId: row.id,
    asOf,
    countryCode: input.countryCode ?? null,
    riskTier: input.riskTier ?? null,
  });

  const monetary = evaluateProviderMonetaryEligibility({
    providerId: row.id,
    providerCode: row.code,
    productionMonetaryStatus: row.production_monetary_status,
    cashRewardPolicyApproved: capabilities.cashRewardPolicyApproved,
    serverSignalAuthentication: capabilities.serverSignalAuthentication,
    sessionOrImpressionCorrelation: capabilities.sessionOrImpressionCorrelation,
    health: health.status,
    openClarificationCount,
    requestHardLimitExceeded: false,
    successHardLimitExceeded: false,
  });

  const adapter = findProvider(row.code);

  return {
    providerId: row.id,
    providerCode: row.code,
    name: row.name,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    productionMonetaryStatus: row.production_monetary_status,
    rewardedUseAllowed: row.rewarded_use_allowed,
    incentivizedCryptoAllowed: row.incentivized_crypto_allowed,
    policyReference: row.policy_reference,
    capabilities,
    adapterCapabilities: adapter === null ? null : adapter.getCapabilities(),
    adapterRegistered: adapter !== null,
    monetary,
    limits,
    health,
    clarifications,
    openClarificationCount,
  };
}

/** Hard-ceiling helper shared by the admin view and the reward gate. */
export function hardCeilingFor(
  limits: EffectiveProviderLimits,
  metric: 'REQUEST' | 'SUCCESS',
): number | null {
  const dimension = limits.byDimension.find(
    (candidate) => candidate.metric === metric && candidate.window === 'UTC_DAY',
  );
  if (dimension === undefined) return null;
  if (dimension.hardCeilingMaxCount !== null) return dimension.hardCeilingMaxCount;
  const hard = dimension.applicableRules.filter((rule) =>
    HARD_LIMIT_SCOPES.includes(rule.limitScope),
  );
  return hard.length === 0 ? null : Math.min(...hard.map((rule) => rule.maxCount));
}
