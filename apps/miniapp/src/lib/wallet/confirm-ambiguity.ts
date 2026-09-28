/**
 * Ambiguous POST /v1/withdrawals failures must not auto-resend.
 * Ordinary ApiError responses are definitive; transport/network failures are not.
 */
import type { WithdrawalListItem } from '../api/client';
import { ApiError } from '../api/client';

export class AmbiguousConfirmError extends Error {
  constructor(message = 'AMBIGUOUS_CONFIRM') {
    super(message);
    this.name = 'AmbiguousConfirmError';
  }
}

/** True when the failure does not prove the server rejected or accepted the create. */
export function isAmbiguousTransportFailure(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (err instanceof AmbiguousConfirmError) return true;
  return true;
}

/** Reconcile an ambiguous confirm against the authoritative withdrawal list. */
export function findWithdrawalByQuoteId(
  withdrawals: readonly WithdrawalListItem[],
  quoteId: string,
): WithdrawalListItem | null {
  return withdrawals.find((item) => item.quoteId === quoteId) ?? null;
}
