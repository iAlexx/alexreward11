import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';
import type { TrustSignalFact } from './trust-evaluator.js';
import type {
  ResolvedTrustRuleVersion,
  TrustPolicyConfig,
  TrustSignalCode,
} from './trust-rule.js';

export interface CollectConfiguredTrustSignalsInput {
  readonly userId: string;
  readonly rule: ResolvedTrustRuleVersion;
}

export interface CollectConfiguredTrustSignalsResult {
  readonly signalFacts: readonly TrustSignalFact[];
  /** Deterministic safe evidence for snapshot audit (no sensitive raw fields). */
  readonly signalEvidence: readonly TrustSignalFact[];
}

interface TrustSourceSnapshot {
  readonly userExists: boolean;
  readonly accountAgeDays: number | null;
  /**
   * Greatest verified-primary age in whole days across qualifying wallets.
   * Null when no active verified primary wallet has BOTH verified_at and
   * became_primary_at (age evidence unavailable / unsatisfied).
   */
  readonly walletAgeDays: number | null;
  /** True when at least one verified active primary wallet exists (age may still be unavailable). */
  readonly hasVerifiedPrimary: boolean;
  readonly rewardedAdCount: number;
  readonly confirmedPayoutCount: number;
}

/**
 * Load Trust collector aggregates in ONE static statement so all collectors
 * observe the same READ COMMITTED statement snapshot.
 *
 * Sources (no Founder / membership / username / language):
 *   ACCOUNT_AGE — users.created_at age in whole days
 *   VERIFIED_PRIMARY_WALLET_AGE — verified active primary user_wallets;
 *     per-wallet age starts at GREATEST(verified_at, became_primary_at) only when
 *     BOTH timestamps are non-null (no created_at fallback); MAX across wallets
 *   REWARDED_AD_HISTORY — reward_events source_type=AD state=AVAILABLE (all-time)
 *   CONFIRMED_PAYOUT_HISTORY — withdrawals.state=CONFIRMED (all-time)
 */
async function loadTrustSourceSnapshot(
  client: PoolClient,
  userId: string,
): Promise<TrustSourceSnapshot> {
  const result = await client.query<{
    user_exists: boolean;
    account_age_days: number | null;
    wallet_age_days: number | null;
    has_verified_primary: boolean;
    rewarded_ad_count: number;
    confirmed_payout_count: number;
  }>(
    `WITH target AS (
       SELECT id, created_at FROM users WHERE id = $1::uuid
     ),
     wallet_age AS (
       SELECT
         MAX(
           CASE
             WHEN verified_at IS NOT NULL AND became_primary_at IS NOT NULL THEN
               FLOOR(
                 EXTRACT(
                   EPOCH FROM (now() - GREATEST(verified_at, became_primary_at))
                 ) / 86400
               )::int
             ELSE NULL
           END
         ) AS wallet_age_days,
         COALESCE(BOOL_OR(true), false) AS has_verified_primary
       FROM user_wallets
       WHERE user_id = $1::uuid
         AND verified = true
         AND is_primary = true
         AND disabled_at IS NULL
     ),
     ad_rewards AS (
       SELECT COUNT(*)::int AS rewarded_ad_count
       FROM reward_events
       WHERE user_id = $1::uuid
         AND source_type = 'AD'
         AND state = 'AVAILABLE'
     ),
     payouts AS (
       SELECT COUNT(*)::int AS confirmed_payout_count
       FROM withdrawals
       WHERE user_id = $1::uuid
         AND state = 'CONFIRMED'
     )
     SELECT
       EXISTS (SELECT 1 FROM target) AS user_exists,
       CASE
         WHEN EXISTS (SELECT 1 FROM target) THEN
           FLOOR(
             EXTRACT(EPOCH FROM (now() - (SELECT created_at FROM target))) / 86400
           )::int
         ELSE NULL
       END AS account_age_days,
       wallet_age.wallet_age_days,
       wallet_age.has_verified_primary,
       ad_rewards.rewarded_ad_count,
       payouts.confirmed_payout_count
     FROM wallet_age
     CROSS JOIN ad_rewards
     CROSS JOIN payouts`,
    [userId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError('INTERNAL', 'trust signal source snapshot returned no row');
  }

  return {
    userExists: row.user_exists,
    accountAgeDays: row.account_age_days,
    walletAgeDays: row.wallet_age_days,
    hasVerifiedPrimary: row.has_verified_primary,
    rewardedAdCount: row.rewarded_ad_count,
    confirmedPayoutCount: row.confirmed_payout_count,
  };
}

function configuredCodes(policy: TrustPolicyConfig): readonly TrustSignalCode[] {
  const codes: TrustSignalCode[] = [];
  if (policy.signals.ACCOUNT_AGE !== undefined) codes.push('ACCOUNT_AGE');
  if (policy.signals.VERIFIED_PRIMARY_WALLET_AGE !== undefined) {
    codes.push('VERIFIED_PRIMARY_WALLET_AGE');
  }
  if (policy.signals.REWARDED_AD_HISTORY !== undefined) codes.push('REWARDED_AD_HISTORY');
  if (policy.signals.CONFIRMED_PAYOUT_HISTORY !== undefined) {
    codes.push('CONFIRMED_PAYOUT_HISTORY');
  }
  return codes;
}

function buildFact(
  code: TrustSignalCode,
  satisfied: boolean,
  safeDetails: Readonly<Record<string, unknown>>,
): TrustSignalFact {
  return {
    code,
    satisfied,
    reasonCode: satisfied ? `${code}_MET` : `${code}_NOT_MET`,
    safeDetails,
  };
}

/**
 * Collect only the Trust signals configured on the resolved ACTIVE rule.
 * Facts are ordered by signal code ascending for deterministic evaluation.
 */
export async function collectConfiguredTrustSignals(
  client: PoolClient,
  input: CollectConfiguredTrustSignalsInput,
): Promise<CollectConfiguredTrustSignalsResult> {
  const policy = input.rule.policyConfig;
  const codes = configuredCodes(policy);
  if (codes.length === 0) {
    throw new FraudDomainError(
      'TRUST_POLICY_CONFIG_INVALID',
      'ACTIVE trust rule has no configured signals',
      { ruleVersion: input.rule.ruleVersion },
    );
  }

  const snapshot = await loadTrustSourceSnapshot(client, input.userId);
  if (!snapshot.userExists) {
    throw new FraudDomainError(
      'TRUST_SNAPSHOT_INVALID',
      'user does not exist for trust evaluation',
      { userId: input.userId },
    );
  }

  const facts: TrustSignalFact[] = [];

  for (const code of [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    switch (code) {
      case 'ACCOUNT_AGE': {
        const cfg = policy.signals.ACCOUNT_AGE!;
        const ageDays = snapshot.accountAgeDays ?? 0;
        facts.push(
          buildFact(code, ageDays >= cfg.minDays, {
            ageDays,
            minDays: cfg.minDays,
          }),
        );
        break;
      }
      case 'VERIFIED_PRIMARY_WALLET_AGE': {
        const cfg = policy.signals.VERIFIED_PRIMARY_WALLET_AGE!;
        const ageDays = snapshot.walletAgeDays;
        const ageEstablished = ageDays !== null;
        const satisfied = ageEstablished && ageDays >= cfg.minDays;
        facts.push(
          buildFact(code, satisfied, {
            ageDays: ageEstablished ? ageDays : 0,
            minDays: cfg.minDays,
            hasVerifiedPrimary: snapshot.hasVerifiedPrimary,
            ageEstablished,
          }),
        );
        break;
      }
      case 'REWARDED_AD_HISTORY': {
        const cfg = policy.signals.REWARDED_AD_HISTORY!;
        facts.push(
          buildFact(code, snapshot.rewardedAdCount >= cfg.minCount, {
            count: snapshot.rewardedAdCount,
            minCount: cfg.minCount,
          }),
        );
        break;
      }
      case 'CONFIRMED_PAYOUT_HISTORY': {
        const cfg = policy.signals.CONFIRMED_PAYOUT_HISTORY!;
        facts.push(
          buildFact(code, snapshot.confirmedPayoutCount >= cfg.minCount, {
            count: snapshot.confirmedPayoutCount,
            minCount: cfg.minCount,
          }),
        );
        break;
      }
      default: {
        const _exhaustive: never = code;
        throw new FraudDomainError(
          'INTERNAL',
          `unsupported trust signal ${_exhaustive as string}`,
        );
      }
    }
  }

  return {
    signalFacts: facts,
    signalEvidence: facts,
  };
}
