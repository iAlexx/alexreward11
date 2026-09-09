import { WithdrawalDomainError } from './errors.js';

const DIGITS = /^\d+$/;

export function parsePositiveAtomic(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!DIGITS.test(trimmed)) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      `${label} must be a positive integer atomic string`,
    );
  }
  const n = BigInt(trimmed);
  if (n <= 0n) {
    throw new WithdrawalDomainError('VALIDATION', `${label} must be positive`);
  }
  return n;
}

export function parseNonNegativeAtomic(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!DIGITS.test(trimmed)) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      `${label} must be a non-negative integer atomic string`,
    );
  }
  return BigInt(trimmed);
}

export function atomicToString(value: bigint): string {
  if (value < 0n) {
    throw new WithdrawalDomainError('VALIDATION', 'atomic amount cannot be negative');
  }
  return value.toString(10);
}

/**
 * Membership platform-fee discount:
 * discount = FLOOR(base * bps / 10000)
 * final = base - discount
 * Require 0 <= final <= base.
 */
export function applyPlatformFeeDiscount(
  baseFeeAtomic: bigint,
  discountBps: number,
): {
  readonly discountAtomic: bigint;
  readonly finalFeeAtomic: bigint;
} {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) {
    throw new WithdrawalDomainError('VALIDATION', 'discount_bps must be 0..10000');
  }
  if (baseFeeAtomic < 0n) {
    throw new WithdrawalDomainError('VALIDATION', 'base fee cannot be negative');
  }
  const discountAtomic = (baseFeeAtomic * BigInt(discountBps)) / 10_000n;
  const finalFeeAtomic = baseFeeAtomic - discountAtomic;
  if (finalFeeAtomic < 0n || finalFeeAtomic > baseFeeAtomic) {
    throw new WithdrawalDomainError('INTERNAL', 'fee discount arithmetic invariant broken');
  }
  return { discountAtomic, finalFeeAtomic };
}

export function computeNetAmount(grossAtomic: bigint, finalFeeAtomic: bigint): bigint {
  const net = grossAtomic - finalFeeAtomic;
  if (net <= 0n) {
    throw new WithdrawalDomainError('VALIDATION', 'net withdrawal amount must be positive');
  }
  return net;
}
