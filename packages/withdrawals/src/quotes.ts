import type { PoolClient } from 'pg';

import {
  applyPlatformFeeDiscount,
  atomicToString,
  computeNetAmount,
  parsePositiveAtomic,
} from './arithmetic.js';
import { assertWithdrawalEngineConfig, type WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { resolvePlatformFeeDiscount, resolvePriorityReview } from './entitlements.js';
import { WithdrawalDomainError } from './errors.js';
import { assertWithdrawalRequestsAllowed } from './flags.js';
import { resolveActiveFeeRule, resolveActiveLimitRule } from './rules.js';
import { assertWithdrawalVolumeHeadroom, resolveSinglePayoutHotWallet } from './volume.js';
import { requireEligiblePrimaryWallet } from './wallet-gate.js';

export interface WithdrawalQuoteView {
  readonly id: string;
  readonly userId: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly primaryWalletId: string;
  readonly requestedAmountAtomic: string;
  readonly feeAmountAtomic: string;
  readonly netAmountAtomic: string;
  readonly basePlatformFeeAtomic: string;
  readonly membershipFeeDiscountBps: number;
  readonly feeRuleId: string;
  readonly feeRuleVersion: number;
  readonly limitRuleId: string;
  readonly limitRuleVersion: number;
  readonly priorityReview: boolean;
  readonly status: string;
  readonly expiresAt: Date;
}

async function resolveNetworkAndAsset(
  client: PoolClient,
  config: WithdrawalEngineConfig,
): Promise<{ networkId: string; assetId: string }> {
  const network = await client.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = $1 AND status = 'ACTIVE'`,
    [config.acceptedNetworkCode],
  );
  const networkId = network.rows[0]?.id;
  if (networkId === undefined) {
    throw new WithdrawalDomainError('CONFIG', 'Accepted network not found');
  }
  if ((network.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError('CONFIG', 'Ambiguous accepted networks');
  }

  // Authoritative: asset must belong to the selected network (no cross-network USDT).
  const asset = await client.query<{ id: string; is_native: boolean }>(
    `SELECT id, is_native
     FROM assets
     WHERE network_id = $1::uuid
       AND symbol = $2
       AND status = 'ACTIVE'
     FOR SHARE`,
    [networkId, config.usdtSymbol],
  );
  if (asset.rowCount === 0) {
    throw new WithdrawalDomainError('CONFIG', 'Withdrawal asset not found for network');
  }
  if ((asset.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError('CONFIG', 'Ambiguous withdrawal assets for network');
  }
  const row = asset.rows[0]!;
  if (config.usdtSymbol === 'USDT' && row.is_native) {
    throw new WithdrawalDomainError('CONFIG', 'USDT withdrawal asset must be non-native');
  }
  return { networkId, assetId: row.id };
}

export async function createWithdrawalQuote(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  input: { readonly authenticatedUserId: string; readonly amountAtomic: string },
): Promise<WithdrawalQuoteView> {
  assertWithdrawalEngineConfig(config);
  const gross = parsePositiveAtomic(input.amountAtomic, 'amountAtomic');

  return withWithdrawalTransaction(db, async (client) => {
    await assertWithdrawalRequestsAllowed(client, config.deploymentEnvironment);
    const { networkId, assetId } = await resolveNetworkAndAsset(client, config);
    const wallet = await requireEligiblePrimaryWallet(client, {
      userId: input.authenticatedUserId,
      networkId,
    });

    const asOf = new Date();
    const feeRule = await resolveActiveFeeRule(client, { assetId, networkId, asOf });
    const limitRule = await resolveActiveLimitRule(client, {
      assetId,
      networkId,
      asOf,
      riskTier: null,
    });

    if (gross < limitRule.minWithdrawalAtomic || gross > limitRule.maxSingleWithdrawalAtomic) {
      throw new WithdrawalDomainError(
        'LIMIT_EXCEEDED',
        'Gross amount outside single-withdrawal limits',
        {
          details: {
            min: atomicToString(limitRule.minWithdrawalAtomic),
            max: atomicToString(limitRule.maxSingleWithdrawalAtomic),
          },
        },
      );
    }

    const hotWallet = await resolveSinglePayoutHotWallet(client, networkId, {
      fakeChainEnabled: config.fakeChainEnabled,
    });
    await assertWithdrawalVolumeHeadroom(client, {
      userId: input.authenticatedUserId,
      hotWalletId: hotWallet.id,
      assetId,
      networkId,
      grossAtomic: gross,
      limits: limitRule,
      asOf,
    });

    const feeDiscount = await resolvePlatformFeeDiscount(client, {
      userId: input.authenticatedUserId,
      assetId,
      asOf,
    });
    const priority = await resolvePriorityReview(client, {
      userId: input.authenticatedUserId,
      asOf,
    });

    const discountBps = feeDiscount?.discountBps ?? 0;
    const { finalFeeAtomic } = applyPlatformFeeDiscount(feeRule.fixedFeeAtomic, discountBps);
    const netAtomic = computeNetAmount(gross, finalFeeAtomic);
    const expiresAt = new Date(asOf.getTime() + config.quoteTtlSeconds * 1000);

    const inserted = await client.query<{
      id: string;
      user_id: string;
      asset_id: string;
      network_id: string;
      primary_wallet_id: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      base_platform_fee_atomic: string;
      membership_fee_discount_bps: number;
      fee_rule_id: string;
      fee_rule_version: number;
      limit_rule_id: string;
      limit_rule_version: number;
      priority_review: boolean;
      status: string;
      expires_at: Date;
    }>(
      `INSERT INTO withdrawal_quotes (
         user_id, asset_id, network_id, primary_wallet_id,
         requested_amount_atomic, fee_amount_atomic, net_amount_atomic,
         fee_rule_id, fee_rule_version, limit_rule_version, limit_rule_id,
         membership_fee_discount_bps, base_platform_fee_atomic,
         user_membership_id, fee_entitlement_rule_version_id,
         priority_entitlement_rule_version_id, priority_review,
         status, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::bigint, $6::bigint, $7::bigint,
         $8::uuid, $9, $10, $11::uuid,
         $12, $13::bigint,
         $14::uuid, $15::uuid,
         $16::uuid, $17,
         'OPEN', $18::timestamptz
       )
       RETURNING id, user_id, asset_id, network_id, primary_wallet_id,
                 requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
                 base_platform_fee_atomic::text, membership_fee_discount_bps,
                 fee_rule_id, fee_rule_version, limit_rule_id, limit_rule_version,
                 priority_review, status::text AS status, expires_at`,
      [
        input.authenticatedUserId,
        assetId,
        networkId,
        wallet.id,
        atomicToString(gross),
        atomicToString(finalFeeAtomic),
        atomicToString(netAtomic),
        feeRule.id,
        feeRule.ruleVersion,
        limitRule.ruleVersion,
        limitRule.id,
        discountBps,
        atomicToString(feeRule.fixedFeeAtomic),
        feeDiscount?.userMembershipId ?? priority?.userMembershipId ?? null,
        feeDiscount?.ruleVersionId ?? null,
        priority?.ruleVersionId ?? null,
        priority !== null,
        expiresAt.toISOString(),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new WithdrawalDomainError('INTERNAL', 'quote insert failed');
    }
    return mapQuote(row);
  });
}

export async function cancelWithdrawalQuote(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  input: { readonly authenticatedUserId: string; readonly quoteId: string },
): Promise<WithdrawalQuoteView> {
  assertWithdrawalEngineConfig(config);
  return withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      id: string;
      user_id: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, user_id, status::text AS status, expires_at
       FROM withdrawal_quotes
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.quoteId],
    );
    const quote = locked.rows[0];
    if (quote === undefined) {
      throw new WithdrawalDomainError('QUOTE_NOT_FOUND', 'Quote not found');
    }
    if (quote.user_id !== input.authenticatedUserId) {
      throw new WithdrawalDomainError('UNAUTHORIZED', 'Authentication required');
    }
    if (quote.status === 'CANCELLED') {
      const existing = await client.query<{
        id: string;
        user_id: string;
        asset_id: string;
        network_id: string;
        primary_wallet_id: string;
        requested_amount_atomic: string;
        fee_amount_atomic: string;
        net_amount_atomic: string;
        base_platform_fee_atomic: string;
        membership_fee_discount_bps: number;
        fee_rule_id: string;
        fee_rule_version: number;
        limit_rule_id: string;
        limit_rule_version: number;
        priority_review: boolean;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, user_id, asset_id, network_id, primary_wallet_id,
                requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
                COALESCE(base_platform_fee_atomic, fee_amount_atomic)::text AS base_platform_fee_atomic,
                membership_fee_discount_bps, fee_rule_id, fee_rule_version,
                limit_rule_id, limit_rule_version, priority_review,
                status::text AS status, expires_at
         FROM withdrawal_quotes WHERE id = $1::uuid`,
        [input.quoteId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new WithdrawalDomainError('QUOTE_NOT_FOUND', 'Quote not found');
      }
      return mapQuote(row);
    }
    if (quote.status !== 'OPEN') {
      throw new WithdrawalDomainError('QUOTE_NOT_OPEN', 'Quote is not open');
    }
    if (quote.expires_at.getTime() <= Date.now()) {
      await client.query(
        `UPDATE withdrawal_quotes
         SET status = 'EXPIRED', updated_at = now()
         WHERE id = $1::uuid AND status = 'OPEN'`,
        [input.quoteId],
      );
      throw new WithdrawalDomainError('QUOTE_EXPIRED', 'Quote expired');
    }

    const updated = await client.query<{
      id: string;
      user_id: string;
      asset_id: string;
      network_id: string;
      primary_wallet_id: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      base_platform_fee_atomic: string;
      membership_fee_discount_bps: number;
      fee_rule_id: string;
      fee_rule_version: number;
      limit_rule_id: string;
      limit_rule_version: number;
      priority_review: boolean;
      status: string;
      expires_at: Date;
    }>(
      `UPDATE withdrawal_quotes
       SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'OPEN'
       RETURNING id, user_id, asset_id, network_id, primary_wallet_id,
                 requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
                 COALESCE(base_platform_fee_atomic, fee_amount_atomic)::text AS base_platform_fee_atomic,
                 membership_fee_discount_bps, fee_rule_id, fee_rule_version,
                 limit_rule_id, limit_rule_version, priority_review,
                 status::text AS status, expires_at`,
      [input.quoteId],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new WithdrawalDomainError('QUOTE_NOT_OPEN', 'Quote is not open');
    }
    return mapQuote(row);
  });
}

/** Expire a single OPEN quote past expires_at. No-op if not expired/open. */
export async function expireWithdrawalQuote(db: WithdrawalDb, quoteId: string): Promise<boolean> {
  return withWithdrawalTransaction(db, async (client) => {
    const result = await client.query(
      `UPDATE withdrawal_quotes
       SET status = 'EXPIRED', updated_at = now()
       WHERE id = $1::uuid
         AND status = 'OPEN'
         AND expires_at <= now()`,
      [quoteId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

function mapQuote(row: {
  id: string;
  user_id: string;
  asset_id: string;
  network_id: string;
  primary_wallet_id: string;
  requested_amount_atomic: string;
  fee_amount_atomic: string;
  net_amount_atomic: string;
  base_platform_fee_atomic: string;
  membership_fee_discount_bps: number;
  fee_rule_id: string;
  fee_rule_version: number;
  limit_rule_id: string;
  limit_rule_version: number;
  priority_review: boolean;
  status: string;
  expires_at: Date;
}): WithdrawalQuoteView {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    networkId: row.network_id,
    primaryWalletId: row.primary_wallet_id,
    requestedAmountAtomic: row.requested_amount_atomic,
    feeAmountAtomic: row.fee_amount_atomic,
    netAmountAtomic: row.net_amount_atomic,
    basePlatformFeeAtomic: row.base_platform_fee_atomic,
    membershipFeeDiscountBps: row.membership_fee_discount_bps,
    feeRuleId: row.fee_rule_id,
    feeRuleVersion: row.fee_rule_version,
    limitRuleId: row.limit_rule_id,
    limitRuleVersion: row.limit_rule_version,
    priorityReview: row.priority_review,
    status: row.status,
    expiresAt: row.expires_at,
  };
}
