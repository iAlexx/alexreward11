import type { BalanceBucketDto, UserBalancesResponse } from '@alex-rewards/contracts';
import type { UserLedgerBalances } from '@alex-rewards/ledger';

/**
 * A bucket the ledger could answer for.
 *
 * `amountAtomic` is whatever the ledger projection holds — including `'0'` for a user who
 * has never been credited. That zero is authoritative, not a placeholder.
 */
export function readyBucket(
  amountAtomic: string,
  assetSymbol: string,
  assetId: string | null,
): BalanceBucketDto {
  return { state: 'READY', amountAtomic, assetSymbol, assetId };
}

/**
 * A bucket that could not be read.
 *
 * `amountAtomic` is `'0'` purely because the field is non-optional; `state` is the field
 * that matters and the client must not render an UNAVAILABLE bucket as a balance.
 */
export function unavailableBucket(assetSymbol: string, assetId: string | null): BalanceBucketDto {
  return { state: 'UNAVAILABLE', amountAtomic: '0', assetSymbol, assetId };
}

/**
 * Project the ledger buckets and the matured-reward history onto the balances response.
 *
 * Lifetime earned is read separately from the reward records, so it can be UNAVAILABLE
 * while the three spendable buckets are still authoritative.
 */
export function toUserBalancesResponse(
  balances: UserLedgerBalances,
  lifetimeEarnedAtomic: string | null,
): UserBalancesResponse {
  const { assetSymbol, assetId } = balances;
  return {
    asOf: balances.asOf,
    available: readyBucket(
      balances.buckets.USER_AVAILABLE_LIABILITY.amountAtomic,
      assetSymbol,
      assetId,
    ),
    pending: readyBucket(
      balances.buckets.USER_PENDING_LIABILITY.amountAtomic,
      assetSymbol,
      assetId,
    ),
    reserved: readyBucket(
      balances.buckets.USER_RESERVED_LIABILITY.amountAtomic,
      assetSymbol,
      assetId,
    ),
    lifetimeEarned:
      lifetimeEarnedAtomic === null
        ? unavailableBucket(assetSymbol, assetId)
        : readyBucket(lifetimeEarnedAtomic, assetSymbol, assetId),
  };
}
