import { LedgerDomainError } from './errors.js';

/** PostgreSQL BIGINT signed range. */
export const PG_BIGINT_MIN = -9223372036854775808n;
export const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * Parse a ledger amount at a domain/API boundary.
 * Accepts bigint or decimal-digit string only. Rejects 0, negatives, fractions, NaN, unsafe Number.
 */
export function parsePositiveAtomicAmount(value: bigint | string): bigint {
  let amount: bigint;
  if (typeof value === 'bigint') {
    amount = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      throw new LedgerDomainError('VALIDATION', 'amountAtomic must be a positive integer string', {
        details: { reason: 'INVALID_AMOUNT_FORMAT' },
      });
    }
    try {
      amount = BigInt(trimmed);
    } catch (cause) {
      throw new LedgerDomainError('VALIDATION', 'amountAtomic could not be parsed', {
        cause,
        details: { reason: 'INVALID_AMOUNT_PARSE' },
      });
    }
  } else {
    throw new LedgerDomainError('VALIDATION', 'amountAtomic must be bigint or string', {
      details: { reason: 'INVALID_AMOUNT_TYPE' },
    });
  }

  if (amount <= 0n) {
    throw new LedgerDomainError('VALIDATION', 'amountAtomic must be greater than zero', {
      details: { reason: 'NON_POSITIVE_AMOUNT' },
    });
  }
  if (amount > PG_BIGINT_MAX) {
    throw new LedgerDomainError('VALIDATION', 'amountAtomic exceeds PostgreSQL BIGINT range', {
      details: { reason: 'AMOUNT_OVERFLOW' },
    });
  }
  return amount;
}

/** Serialize atomic amounts for APIs / contracts (never Number). */
export function amountAtomicToString(value: bigint): string {
  if (value < PG_BIGINT_MIN || value > PG_BIGINT_MAX) {
    throw new LedgerDomainError('VALIDATION', 'amountAtomic out of PostgreSQL BIGINT range');
  }
  return value.toString(10);
}

export function parseSignedAtomicBalance(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    throw new LedgerDomainError('VALIDATION', 'balance must not use JS number', {
      details: { reason: 'UNSAFE_NUMBER' },
    });
  }
  if (!/^-?[0-9]+$/.test(value.trim())) {
    throw new LedgerDomainError('VALIDATION', 'invalid balance atomic string');
  }
  return BigInt(value.trim());
}
