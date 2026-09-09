import { describe, expect, it } from 'vitest';

import {
  applyPlatformFeeDiscount,
  atomicToString,
  computeNetAmount,
  parseNonNegativeAtomic,
  parsePositiveAtomic,
  WithdrawalDomainError,
} from '../src/index.js';

describe('Phase 7 fee arithmetic (unit)', () => {
  it('parses positive and non-negative atomic strings', () => {
    expect(parsePositiveAtomic('200000', 'amount')).toBe(200000n);
    expect(parseNonNegativeAtomic('0', 'fee')).toBe(0n);
    expect(() => parsePositiveAtomic('0', 'amount')).toThrow(WithdrawalDomainError);
    expect(() => parsePositiveAtomic('-1', 'amount')).toThrow(WithdrawalDomainError);
  });

  it('applies platform fee discount with floor division', () => {
    const half = applyPlatformFeeDiscount(10_000n, 5000);
    expect(half.discountAtomic).toBe(5000n);
    expect(half.finalFeeAtomic).toBe(5000n);

    const full = applyPlatformFeeDiscount(10_000n, 10_000);
    expect(full.finalFeeAtomic).toBe(0n);

    const none = applyPlatformFeeDiscount(10_000n, 0);
    expect(none.finalFeeAtomic).toBe(10_000n);
  });

  it('rejects invalid discount bps', () => {
    expect(() => applyPlatformFeeDiscount(10_000n, 10001)).toThrow(WithdrawalDomainError);
    expect(() => applyPlatformFeeDiscount(10_000n, -1)).toThrow(WithdrawalDomainError);
  });

  it('computeNetAmount rejects net<=0', () => {
    expect(computeNetAmount(200_000n, 10_000n)).toBe(190_000n);
    expect(() => computeNetAmount(10_000n, 10_000n)).toThrow(WithdrawalDomainError);
    expect(() => computeNetAmount(9_000n, 10_000n)).toThrow(WithdrawalDomainError);
  });

  it('atomicToString rejects negatives', () => {
    expect(atomicToString(0n)).toBe('0');
    expect(() => atomicToString(-1n)).toThrow(WithdrawalDomainError);
  });
});
