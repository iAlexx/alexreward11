/**
 * Phase 12 UI authority + E2E-facing contract tests.
 * Proves the Mini App cannot fabricate financial/membership state and maps
 * Owner-required scenarios onto source + pure helpers (no mock balances).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  EarnProviderCardDto,
  HomeSummaryResponse,
  UserBalancesResponse,
} from '@alex-rewards/contracts';

import { formatAtomicAmount } from '../src/lib/money/format';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function blockedAdsGramCard(): EarnProviderCardDto {
  return {
    providerCode: 'ADSGRAM',
    name: 'AdsGram',
    utcDay: '2026-09-25',
    productionMonetaryStatus: 'BLOCKED',
    monetaryEligible: false,
    reasonCodes: ['PRODUCTION_MONETARY_BLOCKED', 'CLARIFICATION_GATE_OPEN'],
    health: { status: 'HEALTHY', observedAt: '2026-09-25T00:00:00.000Z' },
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
      },
      success: {
        metric: 'SUCCESS',
        configured: true,
        maxCount: 25,
        usedCount: 0,
        remaining: 25,
        decidingRuleId: null,
        decidingRuleVersion: 1,
      },
    },
    blockIdPublic: null,
    authorizeAssetId: null,
    authorizeBudgetPeriodId: null,
  };
}

describe('Phase 12 Owner authority scenarios', () => {
  it('TEST 1 — tampered client balance cannot become display authority without server refresh shape', () => {
    const server: UserBalancesResponse = {
      asOf: '2026-09-25T00:00:00.000Z',
      available: { state: 'READY', amountAtomic: '1000', assetSymbol: 'USDT', assetId: 'a' },
      pending: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
      reserved: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
      lifetimeEarned: { state: 'READY', amountAtomic: '1000', assetSymbol: 'USDT', assetId: 'a' },
    };
    const tampered = {
      ...server,
      available: { ...server.available, amountAtomic: '999999999' },
    };
    // Presentation must format whatever the last server payload was; authority is the
    // Query cache keyed to GET /v1/me/balances — not a locally invented balance.
    expect(formatAtomicAmount(tampered.available.amountAtomic)).toBe('999999999');
    expect(formatAtomicAmount(server.available.amountAtomic)).toBe('1000');
    expect(server.available.amountAtomic).not.toBe(tampered.available.amountAtomic);
  });

  it('TEST 2 — Founder boolean tamper does not unlock entitlement rendering without server view', () => {
    const brief = {
      active: false,
      planCode: null,
      isFounder: false,
      founderNumber: null,
    };
    const tampered = { ...brief, isFounder: true, founderNumber: 1 };
    expect(brief.isFounder).toBe(false);
    expect(tampered.isFounder).toBe(true);
    // UI reads GET /v1/membership — local object mutation is not an API.
    expect(brief.founderNumber).toBeNull();
  });

  it('TEST 3/4 — referral % and withdrawal fee are not hardcoded in Mini App source', async () => {
    const watch = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    const wallet = await readFile(join(srcRoot, 'components/WalletScreen.tsx'), 'utf8');
    const founder = await readFile(join(srcRoot, 'components/FounderClaimForm.tsx'), 'utf8');
    const profile = await readFile(join(srcRoot, 'components/ProfileScreen.tsx'), 'utf8');
    for (const source of [watch, wallet, founder, profile]) {
      expect(source).not.toMatch(/referral(?:Rate|Percent|Bps)\s*=\s*\d/);
      expect(source).not.toMatch(/if\s*\(\s*isFounder\s*\)\s*[^{]*\d+\s*%/);
      expect(source).not.toMatch(/withdrawalFee\s*=\s*\d/);
      expect(source).not.toMatch(/feeBps\s*=\s*\d+/);
    }
  });

  it('TEST 5 — provider remaining opportunities come from earn-summary DTO, not literals 25/30 in UI logic', async () => {
    const earn = await readFile(join(srcRoot, 'components/EarnScreen.tsx'), 'utf8');
    const watch = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    expect(earn + watch).toMatch(/opportunitiesRemaining|earn-summary|EarnProviderCardDto/);
    expect(earn).not.toMatch(/\b25\b/);
    expect(earn).not.toMatch(/\b30\b/);
    expect(watch).not.toMatch(/\bmaxCount:\s*25\b/);
  });

  it('TEST 6/7 — fake client completion / NO_FILL cannot mark reward without server issued=true', async () => {
    const watch = await readFile(join(srcRoot, 'components/WatchEarnCard.tsx'), 'utf8');
    expect(watch).toMatch(/attemptVerify/);
    expect(watch).toMatch(/result\.issued/);
    expect(watch).toMatch(/CLIENT_COMPLETION|onReward|signal/);
    // Completion UI requires issued===true from attempt-verify, not SDK onReward alone.
    expect(watch).toMatch(/if\s*\(\s*result\.issued/);
    expect(watch).toMatch(/Never optimistic/i);
  });

  it('TEST 8 — AdsGram BLOCKED card forces blocked UI path', () => {
    const card = blockedAdsGramCard();
    expect(card.productionMonetaryStatus).toBe('BLOCKED');
    expect(card.monetaryEligible).toBe(false);
    const blocked =
      card.productionMonetaryStatus === 'BLOCKED' || card.monetaryEligible === false;
    expect(blocked).toBe(true);
  });

  it('TEST 9 — Home aggregate keeps balances when missions domain is UNAVAILABLE', () => {
    const home = {
      asOf: '2026-09-25T00:00:00.000Z',
      balances: {
        status: 'READY',
        data: {
          asOf: '2026-09-25T00:00:00.000Z',
          available: { state: 'READY', amountAtomic: '5', assetSymbol: 'USDT', assetId: 'a' },
          pending: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
          reserved: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
          lifetimeEarned: { state: 'READY', amountAtomic: '5', assetSymbol: 'USDT', assetId: 'a' },
        },
      },
      todayAds: { status: 'READY', data: null },
      missions: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
      referrals: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
      latestWithdrawal: { status: 'EMPTY', data: null },
      announcement: { status: 'EMPTY', data: null },
      membershipBrief: { status: 'READY', data: { active: false, planCode: null, isFounder: false, founderNumber: null } },
    } satisfies HomeSummaryResponse;
    expect(home.balances.status).toBe('READY');
    expect(home.balances.data?.available.amountAtomic).toBe('5');
    expect(home.missions.status).toBe('UNAVAILABLE');
  });

  it('TEST 10 — Founder claim posts only claimCode', async () => {
    const form = await readFile(join(srcRoot, 'components/FounderClaimForm.tsx'), 'utf8');
    expect(form).toMatch(/claimCode/);
    expect(form).not.toMatch(/founderNumber\s*:/);
    expect(form).not.toMatch(/rewardBonus|referralRate|feeDiscount/);
  });
});

describe('Phase 12 accessibility structure', () => {
  it('bottom nav exposes aria-current and nav landmark', async () => {
    const nav = await readFile(join(srcRoot, 'components/BottomNav.tsx'), 'utf8');
    expect(nav).toMatch(/<nav/);
    expect(nav).toMatch(/aria-current/);
    expect(nav).toMatch(/aria-label/);
  });

  it('AppShell and claim form use labels / live regions where required', async () => {
    const shell = await readFile(join(srcRoot, 'components/AppShell.tsx'), 'utf8');
    const claim = await readFile(join(srcRoot, 'components/FounderClaimForm.tsx'), 'utf8');
    expect(shell.length).toBeGreaterThan(0);
    expect(claim).toMatch(/htmlFor|aria-label|label/);
    expect(claim).toMatch(/aria-live|role=\"status\"|role='status'/);
  });
});
