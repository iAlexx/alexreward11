import type { PoolClient } from 'pg';

import { LOCKED_INITIAL_WITHDRAWAL } from './config.js';
import { WithdrawalDomainError } from './errors.js';

export interface FeeRuleRow {
  readonly id: string;
  readonly ruleVersion: number;
  readonly fixedFeeAtomic: bigint;
  readonly percentageBps: number;
  readonly minFeeAtomic: bigint | null;
  readonly maxFeeAtomic: bigint | null;
}

export interface LimitRuleRow {
  readonly id: string;
  readonly ruleVersion: number;
  readonly riskTier: string | null;
  readonly minWithdrawalAtomic: bigint;
  readonly maxSingleWithdrawalAtomic: bigint;
  readonly maxUserHourlyAtomic: bigint;
  readonly maxUserDailyAtomic: bigint;
  readonly maxHotWalletHourlyAtomic: bigint;
  readonly maxHotWalletDailyAtomic: bigint;
  readonly maxAutoPayoutAtomic: bigint | null;
  readonly walletChangeCooldownSeconds: number;
}

export async function resolveActiveFeeRule(
  client: PoolClient,
  input: { readonly assetId: string; readonly networkId: string; readonly asOf: Date },
): Promise<FeeRuleRow> {
  const result = await client.query<{
    id: string;
    rule_version: number;
    fixed_fee_atomic: string;
    percentage_bps: number;
    min_fee_atomic: string | null;
    max_fee_atomic: string | null;
  }>(
    `SELECT id, rule_version, fixed_fee_atomic::text, percentage_bps,
            min_fee_atomic::text, max_fee_atomic::text
     FROM withdrawal_fee_rules
     WHERE asset_id = $1::uuid
       AND network_id = $2::uuid
       AND status = 'ACTIVE'
       AND valid_from <= $3::timestamptz
       AND (valid_to IS NULL OR valid_to > $3::timestamptz)
     FOR SHARE`,
    [input.assetId, input.networkId, input.asOf.toISOString()],
  );
  if (result.rowCount === 0) {
    throw new WithdrawalDomainError('FEE_RULE_NOT_FOUND', 'No active withdrawal fee rule');
  }
  if ((result.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError('FEE_RULE_AMBIGUOUS', 'Ambiguous active withdrawal fee rules');
  }
  const row = result.rows[0]!;
  if (row.percentage_bps !== 0) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Percentage withdrawal fees are not enabled in Phase 7 fixed-fee path',
    );
  }
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    fixedFeeAtomic: BigInt(row.fixed_fee_atomic),
    percentageBps: row.percentage_bps,
    minFeeAtomic: row.min_fee_atomic === null ? null : BigInt(row.min_fee_atomic),
    maxFeeAtomic: row.max_fee_atomic === null ? null : BigInt(row.max_fee_atomic),
  };
}

export async function resolveActiveLimitRule(
  client: PoolClient,
  input: {
    readonly assetId: string;
    readonly networkId: string;
    readonly asOf: Date;
    readonly riskTier?: string | null;
  },
): Promise<LimitRuleRow> {
  // Prefer exact risk_tier match when provided; otherwise require a single generic (NULL tier) rule.
  // Never invent precedence between generic and tier-specific — ambiguity FAIL CLOSED.
  const result = await client.query<{
    id: string;
    rule_version: number;
    risk_tier: string | null;
    min_withdrawal_atomic: string;
    max_single_withdrawal_atomic: string;
    max_user_hourly_atomic: string;
    max_user_daily_atomic: string;
    max_hot_wallet_hourly_atomic: string;
    max_hot_wallet_daily_atomic: string;
    max_auto_payout_atomic: string | null;
    wallet_change_cooldown_seconds: number;
  }>(
    `SELECT id, rule_version, risk_tier::text AS risk_tier,
            min_withdrawal_atomic::text, max_single_withdrawal_atomic::text,
            max_user_hourly_atomic::text, max_user_daily_atomic::text,
            max_hot_wallet_hourly_atomic::text, max_hot_wallet_daily_atomic::text,
            max_auto_payout_atomic::text, wallet_change_cooldown_seconds
     FROM withdrawal_limit_rules
     WHERE asset_id = $1::uuid
       AND network_id = $2::uuid
       AND status = 'ACTIVE'
       AND valid_from <= $3::timestamptz
       AND (valid_to IS NULL OR valid_to > $3::timestamptz)
       AND (
         ($4::text IS NULL AND risk_tier IS NULL)
         OR ($4::text IS NOT NULL AND risk_tier::text = $4::text)
       )
     FOR SHARE`,
    [input.assetId, input.networkId, input.asOf.toISOString(), input.riskTier ?? null],
  );
  if (result.rowCount === 0) {
    throw new WithdrawalDomainError('LIMIT_RULE_NOT_FOUND', 'No active withdrawal limit rule');
  }
  if ((result.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError(
      'LIMIT_RULE_AMBIGUOUS',
      'Ambiguous active withdrawal limit rules',
    );
  }
  const row = result.rows[0]!;
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    riskTier: row.risk_tier,
    minWithdrawalAtomic: BigInt(row.min_withdrawal_atomic),
    maxSingleWithdrawalAtomic: BigInt(row.max_single_withdrawal_atomic),
    maxUserHourlyAtomic: BigInt(row.max_user_hourly_atomic),
    maxUserDailyAtomic: BigInt(row.max_user_daily_atomic),
    maxHotWalletHourlyAtomic: BigInt(row.max_hot_wallet_hourly_atomic),
    maxHotWalletDailyAtomic: BigInt(row.max_hot_wallet_daily_atomic),
    maxAutoPayoutAtomic:
      row.max_auto_payout_atomic === null ? null : BigInt(row.max_auto_payout_atomic),
    walletChangeCooldownSeconds: row.wallet_change_cooldown_seconds,
  };
}

/** TEST/LOCAL only: insert locked V1.2 initial fee + limit rules as ACTIVE. */
export async function seedLockedInitialWithdrawalRules(
  client: PoolClient,
  input: { readonly assetId: string; readonly networkId: string },
): Promise<{ feeRuleId: string; limitRuleId: string }> {
  const fee = await client.query<{ id: string }>(
    `INSERT INTO withdrawal_fee_rules (
       asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
       status, valid_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, 1, $3, 0, 'ACTIVE', now(), 'LOCAL FIXTURE locked V1.2 initial fee'
     )
     ON CONFLICT (asset_id, network_id, rule_version) DO UPDATE
       SET status = 'ACTIVE'
     RETURNING id`,
    [input.assetId, input.networkId, LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic.toString(10)],
  );
  const limit = await client.query<{ id: string }>(
    `INSERT INTO withdrawal_limit_rules (
       asset_id, network_id, rule_version, risk_tier,
       min_withdrawal_atomic, max_single_withdrawal_atomic,
       max_user_hourly_atomic, max_user_daily_atomic,
       max_hot_wallet_hourly_atomic, max_hot_wallet_daily_atomic,
       max_auto_payout_atomic, wallet_change_cooldown_seconds,
       status, valid_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, 1, NULL,
       $3, $4, $5, $6, $7, $8,
       NULL, $9,
       'ACTIVE', now(), 'LOCAL FIXTURE locked V1.2 initial limits'
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.assetId,
      input.networkId,
      LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.maxUserHourlyAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.maxUserDailyAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.maxHotWalletHourlyAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.maxHotWalletDailyAtomic.toString(10),
      LOCKED_INITIAL_WITHDRAWAL.walletChangeCooldownSeconds,
    ],
  );
  let limitRuleId = limit.rows[0]?.id;
  if (limitRuleId === undefined) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_limit_rules
       WHERE asset_id = $1::uuid AND network_id = $2::uuid AND rule_version = 1 AND risk_tier IS NULL`,
      [input.assetId, input.networkId],
    );
    limitRuleId = existing.rows[0]?.id;
  }
  const feeRuleId = fee.rows[0]?.id;
  if (feeRuleId === undefined || limitRuleId === undefined) {
    throw new WithdrawalDomainError('INTERNAL', 'failed to seed locked withdrawal rules');
  }
  return { feeRuleId, limitRuleId };
}
