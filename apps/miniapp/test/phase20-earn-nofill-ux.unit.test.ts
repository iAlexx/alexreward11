/**
 * Phase 20 Step 3 — Earn UI honesty for BLOCKED / no-fill / failure / verify outcomes.
 * No fake reward rows. Celebration only when server issued===true.
 */
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
import type { AttemptVerifyResponse } from '../src/lib/api/client';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function baseProvider(overrides: Partial<EarnProviderCardDto> = {}): EarnProviderCardDto {
  return {
    providerCode: 'ADSGRAM',
    name: 'AdsGram',
    utcDay: '2026-10-01',
    productionMonetaryStatus: 'BLOCKED',
    monetaryEligible: false,
    reasonCodes: ['PRODUCTION_MONETARY_STATUS_BLOCKED'],
    health: { status: 'HEALTHY', observedAt: '2026-10-01T00:00:00.000Z' },
    rewardedUseAllowed: true,
    opportunitiesRemaining: {
      request: {
        metric: 'REQUEST',
        configured: true,
        maxCount: 30,
        usedCount: 0,
        remaining: 30,
        decidingRuleId: null,
        decidingRuleVersion: 1,
        usageBasis: 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
      },
      success: {
        metric: 'SUCCESS',
        configured: true,
        maxCount: 25,
        usedCount: 0,
        remaining: 25,
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

function verifyBase(
  overrides: Partial<AttemptVerifyResponse> = {},
): AttemptVerifyResponse {
  return {
    adSessionId: '00000000-0000-4000-8000-000000000001',
    state: 'PENDING_VERIFICATION',
    issued: false,
    alreadyRewarded: false,
    monetary: {
      eligible: false,
      status: 'BLOCKED',
      reasonCodes: ['PRODUCTION_MONETARY_STATUS_BLOCKED'],
    },
    reasonCodes: [],
    baseAmountAtomic: null,
    membershipBonusAmountAtomic: null,
    pendingUntil: null,
    ...overrides,
  };
}

describe('Phase 20 Earn no-fill / BLOCKED UX', () => {
  it('BLOCKED monetary cannot start Watch', () => {
    const gate = resolveEarnAttemptGate(baseProvider());
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toBe('blocked_monetary');
  });

  it('provider unavailable / missing placement blocks start', () => {
    expect(
      resolveEarnAttemptGate(
        baseProvider({
          productionMonetaryStatus: 'APPROVED',
          monetaryEligible: true,
          blockIdPublic: null,
        }),
      ).canStart,
    ).toBe(false);

    expect(
      resolveEarnAttemptGate(
        baseProvider({
          productionMonetaryStatus: 'APPROVED',
          monetaryEligible: true,
          health: { status: 'UNAVAILABLE', observedAt: '2026-10-01T00:00:00.000Z' },
        }),
      ).canStart,
    ).toBe(false);
  });

  it('request/success limits exhausted block start', () => {
    const requestExhausted = resolveEarnAttemptGate(
      baseProvider({
        productionMonetaryStatus: 'APPROVED',
        monetaryEligible: true,
        opportunitiesRemaining: {
          request: {
            metric: 'REQUEST',
            configured: true,
            maxCount: 1,
            usedCount: 1,
            remaining: 0,
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
      }),
    );
    expect(requestExhausted.canStart).toBe(false);
  });

  it('CLIENT_COMPLETION never celebrates; only issued===true does', () => {
    expect(clientCompletionMayCelebrate()).toBe(false);

    const blocked = resolveEarnVerifyOutcome(verifyBase());
    expect(blocked.kind).toBe('monetary_blocked');
    expect(blocked.issuedCelebration).toBeNull();

    const nv = resolveEarnVerifyOutcome(verifyBase({ monetary: null }));
    expect(nv.kind).toBe('not_verified');
    expect(nv.issuedCelebration).toBeNull();

    const already = resolveEarnVerifyOutcome(
      verifyBase({ alreadyRewarded: true, monetary: null }),
    );
    expect(already.kind).toBe('already_rewarded');
    expect(already.issuedCelebration).toBeNull();

    const issued = resolveEarnVerifyOutcome(
      verifyBase({
        issued: true,
        monetary: { eligible: true, status: 'APPROVED', reasonCodes: [] },
        baseAmountAtomic: '1',
      }),
    );
    expect(issued.kind).toBe('issued');
    expect(issued.issuedCelebration?.issued).toBe(true);
  });

  it('WatchEarnCard maps NO_FILL / failures / skip without celebrating', async () => {
    const card = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    expect(card).toMatch(/NO_FILL/);
    expect(card).toMatch(/SKIPPED|USER_SKIPPED/);
    expect(card).toMatch(/issued\s*===\s*true|issuedCelebration|resolveEarnVerifyOutcome/);
    expect(card).not.toMatch(/optimisticBalance|fakeReward|fabricat/i);
    // Client completion path must not celebrate without issued
    expect(card).toMatch(/CLIENT_COMPLETION|onSignalReported|clientCompletion/);
  });

  it('EarnScreen does not invent provider availability or balances', async () => {
    const screen = await readFile(join(srcRoot, 'components/EarnScreen.tsx'), 'utf8');
    expect(screen).not.toMatch(/fakeAvailable|invent.*balance|hardcodedReward/i);
  });
});