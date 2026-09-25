/**
 * User balance read models (Phase 12).
 *
 * Amounts are atomic-unit decimal strings so no client ever performs floating-point money
 * arithmetic. A bucket with no ledger account yet is an authoritative zero (`READY` + `'0'`),
 * not an unknown: the ledger simply has never credited it. A bucket that could not be read
 * is `UNAVAILABLE`, and `amountAtomic` is `'0'` only as a placeholder the client must not
 * render as a balance.
 */

export type BalanceBucketState = 'READY' | 'UNAVAILABLE';

export interface BalanceBucketDto {
  readonly state: BalanceBucketState;
  readonly amountAtomic: string;
  readonly assetSymbol: string;
  readonly assetId: string | null;
}

export interface UserBalancesResponse {
  readonly asOf: string;
  readonly available: BalanceBucketDto;
  readonly pending: BalanceBucketDto;
  readonly reserved: BalanceBucketDto;
  /** Sum of matured (AVAILABLE) reward events for this asset — history, not spendable. */
  readonly lifetimeEarned: BalanceBucketDto;
}
