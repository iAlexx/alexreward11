/**
 * Structural UX validation for withdrawal amountAtomic input.
 * Server remains authoritative for financial limits.
 */
export function isPositiveAtomicAmountInput(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (!/^\d+$/.test(trimmed)) return false;
  try {
    return BigInt(trimmed) > 0n;
  } catch {
    return false;
  }
}

/** Presentational address shortening — full server address remains the authority. */
export function shortenFriendlyAddress(address: string, head = 6, tail = 6): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function isWithdrawalCooldownActive(
  until: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (until === null || until === undefined) return false;
  const parsed = Date.parse(until);
  return Number.isFinite(parsed) && parsed > nowMs;
}

export function isQuoteExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}
