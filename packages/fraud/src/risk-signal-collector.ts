import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';
import type { RiskSignalFact } from './risk-evaluator.js';
import type { RiskRuleVersion } from './risk-rule.js';

/**
 * Phase 14 Step 3/4 threshold-free collector signal codes.
 * Every configured rule signal weight key must map to one of these.
 */
export const STEP3_COLLECTOR_SIGNAL_CODES = [
  'OPEN_HIGH_FRAUD_FLAG',
  'OPEN_CRITICAL_FRAUD_FLAG',
  'CONFIRMED_FRAUD_FLAG',
  'SHARED_PAYOUT_WALLET',
  'SHARED_DEVICE_SIGNAL',
  'SHARED_NETWORK_SIGNAL',
  'NETWORK_COUNTRY_CHANGED',
] as const;

export type Step3CollectorSignalCode = (typeof STEP3_COLLECTOR_SIGNAL_CODES)[number];

const SUPPORTED = new Set<string>(STEP3_COLLECTOR_SIGNAL_CODES);

export interface CollectConfiguredRiskSignalsInput {
  readonly userId: string;
  readonly rule: RiskRuleVersion;
}

export interface CollectConfiguredRiskSignalsResult {
  readonly signalFacts: readonly RiskSignalFact[];
  /** Deterministic safe evidence for snapshot audit (no sensitive raw fields). */
  readonly signalEvidence: readonly RiskSignalFact[];
}

interface SourceSnapshot {
  readonly userExists: boolean;
  readonly openHighCount: number;
  readonly openCriticalCount: number;
  readonly confirmedCount: number;
  /** Distinct other users sharing an active verified primary payout wallet. */
  readonly relatedPayoutAccountCount: number;
  readonly sharedDeviceCount: number;
  /** Distinct other users sharing a current active session ip_hash. */
  readonly relatedNetworkAccountCount: number;
  readonly observationCountConsidered: number;
  readonly networkCountryChanged: boolean;
}

/**
 * Load collector source aggregates in ONE statement so all collectors observe
 * the same READ COMMITTED statement snapshot. SQL is static (no dynamic SQL).
 *
 * SHARED_PAYOUT_WALLET — live user_wallets (verified + primary + not disabled).
 * SHARED_NETWORK_SIGNAL — live user_sessions (non-null ip_hash + active).
 * SHARED_DEVICE_SIGNAL — wallet_relationships (unchanged; no device fingerprinting).
 */
async function loadSourceSnapshot(
  client: PoolClient,
  userId: string,
): Promise<SourceSnapshot> {
  const result = await client.query<{
    user_exists: boolean;
    open_high_count: number;
    open_critical_count: number;
    confirmed_count: number;
    related_payout_account_count: number;
    shared_device_count: number;
    related_network_account_count: number;
    observation_count_considered: number;
    network_country_changed: boolean;
  }>(
    `WITH target AS (
       SELECT id FROM users WHERE id = $1::uuid
     ),
     flag_counts AS (
       SELECT
         COUNT(*) FILTER (
           WHERE status = 'OPEN' AND severity = 'HIGH'
         )::int AS open_high_count,
         COUNT(*) FILTER (
           WHERE status = 'OPEN' AND severity = 'CRITICAL'
         )::int AS open_critical_count,
         COUNT(*) FILTER (
           WHERE status = 'CONFIRMED'
         )::int AS confirmed_count
       FROM fraud_flags
       WHERE user_id = $1::uuid
     ),
     payout_reuse AS (
       SELECT COUNT(DISTINCT other.user_id)::int AS related_payout_account_count
       FROM user_wallets AS target_wallet
       INNER JOIN user_wallets AS other
         ON other.network_id = target_wallet.network_id
        AND other.raw_address = target_wallet.raw_address
        AND other.user_id <> target_wallet.user_id
        AND other.verified = true
        AND other.is_primary = true
        AND other.disabled_at IS NULL
       WHERE target_wallet.user_id = $1::uuid
         AND target_wallet.verified = true
         AND target_wallet.is_primary = true
         AND target_wallet.disabled_at IS NULL
     ),
     network_reuse AS (
       SELECT COUNT(DISTINCT other.user_id)::int AS related_network_account_count
       FROM user_sessions AS target_session
       INNER JOIN user_sessions AS other
         ON other.ip_hash = target_session.ip_hash
        AND other.user_id <> target_session.user_id
        AND other.ip_hash IS NOT NULL
        AND other.revoked_at IS NULL
        AND other.expires_at > now()
       WHERE target_session.user_id = $1::uuid
         AND target_session.ip_hash IS NOT NULL
         AND target_session.revoked_at IS NULL
         AND target_session.expires_at > now()
     ),
     rel_counts AS (
       SELECT
         COUNT(*) FILTER (
           WHERE relationship_type = 'SHARED_DEVICE_SIGNAL'
         )::int AS shared_device_count
       FROM wallet_relationships
       WHERE user_id = $1::uuid OR related_user_id = $1::uuid
     ),
     recent_countries AS (
       SELECT country_code
       FROM network_signals
       WHERE user_id = $1::uuid
         AND country_code IS NOT NULL
       ORDER BY observed_at DESC, id DESC
       LIMIT 2
     ),
     country_agg AS (
       SELECT
         COUNT(*)::int AS observation_count_considered,
         (
           COUNT(*) = 2
           AND MIN(country_code) IS DISTINCT FROM MAX(country_code)
         ) AS network_country_changed
       FROM recent_countries
     )
     SELECT
       EXISTS (SELECT 1 FROM target) AS user_exists,
       flag_counts.open_high_count,
       flag_counts.open_critical_count,
       flag_counts.confirmed_count,
       payout_reuse.related_payout_account_count,
       rel_counts.shared_device_count,
       network_reuse.related_network_account_count,
       country_agg.observation_count_considered,
       country_agg.network_country_changed
     FROM flag_counts
     CROSS JOIN payout_reuse
     CROSS JOIN network_reuse
     CROSS JOIN rel_counts
     CROSS JOIN country_agg`,
    [userId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError('INTERNAL', 'risk signal source snapshot returned no row');
  }

  return {
    userExists: row.user_exists,
    openHighCount: row.open_high_count,
    openCriticalCount: row.open_critical_count,
    confirmedCount: row.confirmed_count,
    relatedPayoutAccountCount: row.related_payout_account_count,
    sharedDeviceCount: row.shared_device_count,
    relatedNetworkAccountCount: row.related_network_account_count,
    observationCountConsidered: row.observation_count_considered,
    networkCountryChanged: row.network_country_changed,
  };
}

function factForCode(code: Step3CollectorSignalCode, source: SourceSnapshot): RiskSignalFact {
  switch (code) {
    case 'OPEN_HIGH_FRAUD_FLAG': {
      const active = source.openHighCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'OPEN_HIGH_FRAUD_FLAG' : 'NO_OPEN_HIGH_FRAUD_FLAG',
        safeDetails: { matchingCount: source.openHighCount },
      };
    }
    case 'OPEN_CRITICAL_FRAUD_FLAG': {
      const active = source.openCriticalCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'OPEN_CRITICAL_FRAUD_FLAG' : 'NO_OPEN_CRITICAL_FRAUD_FLAG',
        safeDetails: { matchingCount: source.openCriticalCount },
      };
    }
    case 'CONFIRMED_FRAUD_FLAG': {
      const active = source.confirmedCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'CONFIRMED_FRAUD_FLAG' : 'NO_CONFIRMED_FRAUD_FLAG',
        safeDetails: { matchingCount: source.confirmedCount },
      };
    }
    case 'SHARED_PAYOUT_WALLET': {
      const relatedAccountCount = source.relatedPayoutAccountCount;
      const active = relatedAccountCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'SHARED_PAYOUT_WALLET' : 'NO_SHARED_PAYOUT_WALLET',
        safeDetails: { relatedAccountCount },
      };
    }
    case 'SHARED_DEVICE_SIGNAL': {
      const active = source.sharedDeviceCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'SHARED_DEVICE_SIGNAL' : 'NO_SHARED_DEVICE_SIGNAL',
        safeDetails: { relationshipCount: source.sharedDeviceCount },
      };
    }
    case 'SHARED_NETWORK_SIGNAL': {
      const relatedAccountCount = source.relatedNetworkAccountCount;
      const active = relatedAccountCount > 0;
      return {
        code,
        active,
        reasonCode: active ? 'SHARED_NETWORK_SIGNAL' : 'NO_SHARED_NETWORK_SIGNAL',
        safeDetails: { relatedAccountCount },
      };
    }
    case 'NETWORK_COUNTRY_CHANGED': {
      const active = source.networkCountryChanged;
      const count = source.observationCountConsidered;
      if (count !== 0 && count !== 1 && count !== 2) {
        throw new FraudDomainError(
          'INTERNAL',
          'observationCountConsidered must be 0, 1, or 2',
          { count },
        );
      }
      return {
        code,
        active,
        reasonCode: active ? 'NETWORK_COUNTRY_CHANGED' : 'NO_NETWORK_COUNTRY_CHANGE',
        safeDetails: {
          observationCountConsidered: count,
          changed: active,
        },
      };
    }
    default: {
      const _exhaustive: never = code;
      throw new FraudDomainError('INTERNAL', `unhandled collector code ${_exhaustive}`);
    }
  }
}

/**
 * Collect exactly one RiskSignalFact per configured ACTIVE-rule signal weight.
 *
 * Fail closed if any configured code lacks a Step 3–5 collector.
 * Does not invent thresholds, write source tables, or execute risk actions.
 */
export async function collectConfiguredRiskSignals(
  client: PoolClient,
  input: CollectConfiguredRiskSignalsInput,
): Promise<CollectConfiguredRiskSignalsResult> {
  const configuredCodes = Object.keys(input.rule.signalWeights).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  for (const code of configuredCodes) {
    if (!SUPPORTED.has(code)) {
      throw new FraudDomainError(
        'RISK_SIGNAL_COLLECTOR_UNSUPPORTED',
        `configured signal code ${code} has no Step 3 collector implementation`,
        { code, ruleVersion: input.rule.ruleVersion },
      );
    }
  }

  const source = await loadSourceSnapshot(client, input.userId);
  if (!source.userExists) {
    throw new FraudDomainError(
      'RISK_SIGNAL_SOURCE_NOT_FOUND',
      'userId does not identify an existing user',
      { userId: input.userId },
    );
  }

  const signalFacts: RiskSignalFact[] = configuredCodes.map((code) =>
    factForCode(code as Step3CollectorSignalCode, source),
  );

  // Evidence mirrors facts (already code-ascending) for snapshot audit.
  const signalEvidence = signalFacts.map((fact) => ({
    code: fact.code,
    active: fact.active,
    reasonCode: fact.reasonCode,
    ...(fact.safeDetails !== undefined ? { safeDetails: fact.safeDetails } : {}),
  }));

  return { signalFacts, signalEvidence };
}
