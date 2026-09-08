import { describe, expect, it } from 'vitest';

import {
  clampRewardAtomic,
  computeMembershipBonusAtomic,
  computeQuotedRewardAtomic,
  computeRawRewardAtomic,
  RewardDomainError,
} from '../src/index.js';

describe('Phase 5 arithmetic (pure)', () => {
  it('computes FLOOR(ecpm * share * safety / (1000*10000*10000))', () => {
    // 1_000_000 * 5000 * 8000 / 100_000_000_000 = 400
    const raw = computeRawRewardAtomic({
      estimatedEcpmAtomic: '1000000',
      userShareBps: 5000,
      safetyFactorBps: 8000,
    });
    expect(raw).toBe(400n);
  });

  it('never uses floating point intermediates for uneven division', () => {
    const raw = computeRawRewardAtomic({
      estimatedEcpmAtomic: '1234567',
      userShareBps: 3333,
      safetyFactorBps: 7777,
    });
    const expected = (1234567n * 3333n * 7777n) / (1000n * 10000n * 10000n);
    expect(raw).toBe(expected);
  });

  it('clamps to min and max after FLOOR', () => {
    expect(
      clampRewardAtomic({
        rawAtomic: 10n,
        minRewardAtomic: 100n,
        maxRewardAtomic: 500n,
      }),
    ).toBe(100n);
    expect(
      clampRewardAtomic({
        rawAtomic: 900n,
        minRewardAtomic: 100n,
        maxRewardAtomic: 500n,
      }),
    ).toBe(500n);
  });

  it('prefers fixed reward when present', () => {
    expect(
      computeQuotedRewardAtomic({
        fixedRewardAtomic: '2500',
        estimatedEcpmAtomic: '1000000',
        userShareBps: 5000,
        safetyFactorBps: 8000,
      }),
    ).toBe(2500n);
  });

  it('computes membership bonus with FLOOR and treats zero as no bonus', () => {
    expect(computeMembershipBonusAtomic({ baseAmountAtomic: '1000', bonusBps: 500 })).toBe(50n);
    expect(computeMembershipBonusAtomic({ baseAmountAtomic: '1', bonusBps: 500 })).toBe(0n);
    expect(computeMembershipBonusAtomic({ baseAmountAtomic: '19', bonusBps: 500 })).toBe(0n);
  });

  it('rejects unsafe Number-like strings and overflow outcomes', () => {
    expect(() =>
      computeRawRewardAtomic({
        estimatedEcpmAtomic: '1.5',
        userShareBps: 1000,
        safetyFactorBps: 1000,
      }),
    ).toThrow(RewardDomainError);
    expect(() => computeMembershipBonusAtomic({ baseAmountAtomic: '-1', bonusBps: 100 })).toThrow(
      RewardDomainError,
    );
  });
});
