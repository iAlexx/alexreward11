import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EarnProviderCardDto } from '@alex-rewards/contracts';
import { describe, expect, it } from 'vitest';

import { resolveEarnAttemptGate } from '../src/lib/earn/earn-action-gate';
import {
  clientCompletionMayCelebrate,
  resolveEarnVerifyOutcome,
} from '../src/lib/earn/earn-verify-outcome';
import {
  formatAtomicAmount,
  formatAtomicAmountGrouped,
} from '../src/lib/money/format';
import type { AttemptVerifyResponse } from '../src/lib/api/client';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function baseProvider(
  overrides: Partial<EarnProviderCardDto> = {},
): EarnProviderCardDto {
  return {
    providerCode: 'ADSGRAM',
    name: 'AdsGram',
    utcDay: '2026-09-28',
    productionMonetaryStatus: 'APPROVED',
    monetaryEligible: true,
    reasonCodes: [],
    health: { status: 'HEALTHY', observedAt: '2026-09-28T00:00:00.000Z' },
    rewardedUseAllowed: true,
    opportunitiesRemaining: {
      request: {
        metric: 'REQUEST',
        configured: true,
        maxCount: 10,
        usedCount: 1,
        remaining: 9,
        decidingRuleId: null,
        decidingRuleVersion: 1,
        usageBasis: 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
      },
      success: {
        metric: 'SUCCESS',
        configured: true,
        maxCount: 8,
        usedCount: 0,
        remaining: 8,
        decidingRuleId: null,
        decidingRuleVersion: 1,
        usageBasis: 'SUCCESSFUL_REWARD',
      },
    },
    blockIdPublic: 'block-public',
    authorizeAssetId: 'asset-1',
    authorizeBudgetPeriodId: 'budget-1',
    ...overrides,
  };
}

describe('LOOTRA Step 3 Earn authority', () => {
  it('A — BLOCKED provider cannot start a monetary Watch attempt', () => {
    const gate = resolveEarnAttemptGate(
      baseProvider({ productionMonetaryStatus: 'BLOCKED', monetaryEligible: false }),
    );
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toBe('blocked_monetary');
  });

  it('B — monetaryEligible=false blocks attempt', () => {
    expect(
      resolveEarnAttemptGate(baseProvider({ monetaryEligible: false })).canStart,
    ).toBe(false);
  });

  it('C — rewardedUseAllowed=false blocks attempt', () => {
    expect(
      resolveEarnAttemptGate(baseProvider({ rewardedUseAllowed: false })).reason,
    ).toBe('rewarded_use_disallowed');
  });

  it('D — UNAVAILABLE/SUSPENDED health blocks attempt', () => {
    expect(
      resolveEarnAttemptGate(
        baseProvider({ health: { status: 'UNAVAILABLE', observedAt: 'x' } }),
      ).reason,
    ).toBe('health_unavailable');
    expect(
      resolveEarnAttemptGate(
        baseProvider({ health: { status: 'SUSPENDED', observedAt: 'x' } }),
      ).reason,
    ).toBe('health_suspended');
  });

  it('E/F — zero remaining limits block attempt', () => {
    const requestZero = baseProvider({
      opportunitiesRemaining: {
        ...baseProvider().opportunitiesRemaining,
        request: {
          ...baseProvider().opportunitiesRemaining.request,
          remaining: 0,
        },
      },
    });
    expect(resolveEarnAttemptGate(requestZero).reason).toBe('request_limit');

    const successZero = baseProvider({
      opportunitiesRemaining: {
        ...baseProvider().opportunitiesRemaining,
        success: {
          ...baseProvider().opportunitiesRemaining.success,
          remaining: 0,
        },
      },
    });
    expect(resolveEarnAttemptGate(successZero).reason).toBe('success_limit');
  });

  it('G/H — missing placement or authorize locators block attempt', () => {
    expect(resolveEarnAttemptGate(baseProvider({ blockIdPublic: null })).reason).toBe(
      'missing_block_id',
    );
    expect(
      resolveEarnAttemptGate(baseProvider({ authorizeAssetId: null })).reason,
    ).toBe('missing_authorize_locators');
    expect(
      resolveEarnAttemptGate(baseProvider({ authorizeBudgetPeriodId: null })).reason,
    ).toBe('missing_authorize_locators');
  });

  it('I — runtime limits come from server objects, not hardcoded 25/30', async () => {
    const watch = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    const gate = await readFile(join(srcRoot, 'lib/earn/earn-action-gate.ts'), 'utf8');
    expect(watch + gate).toMatch(/opportunitiesRemaining/);
    expect(watch).not.toMatch(/\bremaining:\s*25\b/);
    expect(watch).not.toMatch(/\bremaining:\s*30\b/);
    expect(gate).not.toMatch(/\b25\b/);
    expect(gate).not.toMatch(/\b30\b/);
  });

  it('J — quotedAmountAtomic remains atomic (no decimal conversion)', () => {
    expect(formatAtomicAmount('9400000')).toBe('9400000');
    expect(formatAtomicAmountGrouped('9400000').replace(/,/g, '')).toBe('9400000');
    expect(formatAtomicAmountGrouped('9400000')).not.toMatch(/9\.4/);
  });

  it('K — CLIENT_COMPLETION alone cannot produce Reward Drop', () => {
    expect(clientCompletionMayCelebrate()).toBe(false);
  });

  it('L — issued=true produces issued celebration payload', () => {
    const result: AttemptVerifyResponse = {
      adSessionId: 's1',
      state: 'REWARDED',
      issued: true,
      alreadyRewarded: false,
      monetary: { eligible: true, status: 'APPROVED', reasonCodes: [] },
      reasonCodes: [],
      baseAmountAtomic: '1000',
      membershipBonusAmountAtomic: '100',
      pendingUntil: '2026-09-29T00:00:00.000Z',
    };
    const outcome = resolveEarnVerifyOutcome(result);
    expect(outcome.kind).toBe('issued');
    expect(outcome.issuedCelebration?.issued).toBe(true);
  });

  it('M — alreadyRewarded=true does not produce new issuance celebration', () => {
    const outcome = resolveEarnVerifyOutcome({
      adSessionId: 's1',
      state: 'REWARDED',
      issued: false,
      alreadyRewarded: true,
      monetary: null,
      reasonCodes: [],
      baseAmountAtomic: null,
      membershipBonusAmountAtomic: null,
      pendingUntil: null,
    });
    expect(outcome.kind).toBe('already_rewarded');
    expect(outcome.issuedCelebration).toBeNull();
  });

  it('N — issued=false/alreadyRewarded=false does not claim reward', () => {
    const outcome = resolveEarnVerifyOutcome({
      adSessionId: 's1',
      state: 'CLOSED',
      issued: false,
      alreadyRewarded: false,
      monetary: null,
      reasonCodes: ['NOT_VERIFIED'],
      baseAmountAtomic: null,
      membershipBonusAmountAtomic: null,
      pendingUntil: null,
    });
    expect(outcome.kind).toBe('not_verified');
    expect(outcome.issuedCelebration).toBeNull();
  });

  it('O — base + membership bonus are not summed into an invented total', async () => {
    const receipt = await readFile(
      join(srcRoot, 'components/EarnRewardDropReceipt.tsx'),
      'utf8',
    );
    expect(receipt).toMatch(/baseAmountAtomic/);
    expect(receipt).toMatch(/membershipBonusAmountAtomic/);
    expect(receipt).not.toMatch(/baseAmountAtomic\s*\+/);
    expect(receipt).not.toMatch(/BigInt\([^)]+\)\s*\+/);
  });

  it('P — no optimistic balance mutation in Earn sources', async () => {
    const watch = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    const earn = await readFile(join(srcRoot, 'components/EarnScreen.tsx'), 'utf8');
    expect(watch + earn).not.toMatch(/setBalance\s*\(/);
    expect(watch).toMatch(/Never optimistic/i);
    expect(watch).toMatch(/if\s*\(\s*result\.issued/);
  });

  it('approved provider with locators can start', () => {
    expect(resolveEarnAttemptGate(baseProvider()).canStart).toBe(true);
  });
});
