/**
 * Display helpers for server-authored atomic amounts (Admin).
 * BigInt-safe. Never invents zeros for missing values.
 */

export class InvalidAtomicAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAtomicAmountError';
  }
}

const ATOMIC_PATTERN = /^-?\d+$/;

export function parseAtomicAmount(amountAtomic: string): bigint {
  const trimmed = amountAtomic.trim();
  if (!ATOMIC_PATTERN.test(trimmed)) {
    throw new InvalidAtomicAmountError('amountAtomic must be an integer decimal string');
  }
  return BigInt(trimmed);
}

/** Canonical decimal digit string; grouping for readability only. */
export function formatAtomicAmount(amountAtomic: string): string {
  const value = parseAtomicAmount(amountAtomic);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

export function isAtomicAmountString(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC_PATTERN.test(value.trim());
}

/**
 * Format when present; otherwise an explicit unavailable marker — never `"0"`.
 */
export function formatOptionalAtomic(
  amountAtomic: string | null | undefined,
  unavailableLabel = '—',
): string {
  if (amountAtomic === null || amountAtomic === undefined || amountAtomic.trim() === '') {
    return unavailableLabel;
  }
  if (!isAtomicAmountString(amountAtomic)) {
    return unavailableLabel;
  }
  return formatAtomicAmount(amountAtomic);
}
