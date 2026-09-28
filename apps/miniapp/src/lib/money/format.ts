/**
 * Display helpers for server-authored atomic amounts.
 *
 * The Mini App has zero financial authority: it never converts units, rounds for payout, or
 * invents a fractional place. Amounts are shown as base-unit integer strings (BigInt-parsed
 * for validation only). The asset subunit factor is not published on this surface.
 */

export class InvalidAtomicAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAtomicAmountError';
  }
}

const ATOMIC_PATTERN = /^-?\d+$/;

/** Parse a server atomic decimal string. Rejects floats, empty, and non-decimal forms. */
export function parseAtomicAmount(amountAtomic: string): bigint {
  const trimmed = amountAtomic.trim();
  if (!ATOMIC_PATTERN.test(trimmed)) {
    throw new InvalidAtomicAmountError('amountAtomic must be an integer decimal string');
  }
  return BigInt(trimmed);
}

/**
 * Format an atomic amount for display.
 *
 * Returns the canonical decimal digit string (no grouping that could hide precision
 * loss). Callers must not treat the result as a different unit than the server sent.
 */
export function formatAtomicAmount(amountAtomic: string): string {
  const value = parseAtomicAmount(amountAtomic);
  return value.toString();
}

/**
 * Visual thousands grouping only. Every integer digit from the server string is preserved —
 * no rounding and no decimal/subunit conversion.
 */
export function formatAtomicAmountGrouped(amountAtomic: string): string {
  const value = parseAtomicAmount(amountAtomic);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** True when the string is a safe atomic amount the UI may render. */
export function isAtomicAmountString(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC_PATTERN.test(value.trim());
}
