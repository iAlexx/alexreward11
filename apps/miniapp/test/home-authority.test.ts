import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  EarnProviderCardDto,
  EarnSummaryResponse,
  HomeSummaryResponse,
  WalletSummaryResponse,
} from '@alex-rewards/contracts';

import { deriveHomeSmartAction, isEarnOpportunityEligible } from '../src/lib/home/home-smart-action';
import { deriveHomeSurfaceState } from '../src/lib/home/home-surface';
import { resolveHomeWalletCta } from '../src/lib/home/home-wallet-cta';
import {
  formatAtomicAmount,
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../src/lib/money/format';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function emptyHome(overrides: Partial<HomeSummaryResponse> = {}): HomeSummaryResponse {
  return {
    asOf: '2026-09-28T00:00:00.000Z',
    balances: {
      status: 'READY',
      data: {
        asOf: '2026-09-28T00:00:00.000Z',
        available: { state: 'READY', amountAtomic: '9400000', assetSymbol: 'USDT', assetId: 'a' },
        pending: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
        reserved: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
        lifetimeEarned: {
          state: 'READY',
          amountAtomic: '9400000',
          assetSymbol: 'USDT',
          assetId: 'a',
        },
      },
    },
    todayAds: {
      status: 'READY',
      data: {
        utcDay: '2026-09-28',
        providerCode: 'ADSGRAM',
        monetaryEligible: false,
        successRemaining: null,
        requestRemaining: null,
        requestUsageBasis: 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
        successUsageBasis: 'SUCCESSFUL_REWARD',
      },
    },
    missions: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
    referrals: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
    latestWithdrawal: { status: 'EMPTY', data: null },
    announcement: { status: 'EMPTY', data: null },
    membershipBrief: {
      status: 'READY',
      data: { active: false, planCode: null, isFounder: false, founderNumber: null },
    },
    ...overrides,
  };
}

function blockedProvider(): EarnProviderCardDto {
  return {
    providerCode: 'ADSGRAM',
    name: 'AdsGram',
    utcDay: '2026-09-28',
    productionMonetaryStatus: 'BLOCKED',
    monetaryEligible: false,
    reasonCodes: ['PRODUCTION_MONETARY_BLOCKED'],
    health: { status: 'HEALTHY', observedAt: '2026-09-28T00:00:00.000Z' },
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
    blockIdPublic: null,
    authorizeAssetId: null,
    authorizeBudgetPeriodId: null,
  };
}

describe('LOOTRA Step 2 Home authority', () => {
  it('A — atomic balances are not decimal-converted', () => {
    expect(formatAtomicAmount('9400000')).toBe('9400000');
    expect(formatAtomicAmountGrouped('9400000')).toBe('9,400,000');
    expect(formatAtomicAmountGrouped('9400000')).not.toMatch(/9\.4/);
    expect(formatAtomicAmountGrouped('9400000')).not.toBe('9.40');
    expect(formatAtomicAmountGrouped('9400000')).not.toBe('9.400000');
    // Grouped digits equal ungrouped digits when commas removed.
    expect(formatAtomicAmountGrouped('9400000').replace(/,/g, '')).toBe('9400000');
  });

  it('B — UNAVAILABLE balance must not treat placeholder zero as real money', () => {
    const bucket = { state: 'UNAVAILABLE' as const, amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' };
    expect(bucket.state).toBe('UNAVAILABLE');
    expect(bucket.amountAtomic).toBe('0');
    // Display rule: only format when READY.
    const display =
      bucket.state === 'UNAVAILABLE'
        ? null
        : isAtomicAmountString(bucket.amountAtomic)
          ? formatAtomicAmount(bucket.amountAtomic)
          : null;
    expect(display).toBeNull();
  });

  it('C — ENGINE_NOT_ENABLED missions/referrals do not globally degrade Home', () => {
    const home = emptyHome();
    expect(deriveHomeSurfaceState(home)).toBe('READY');

    const readFailed = emptyHome({
      balances: {
        status: 'UNAVAILABLE',
        data: null,
        errorCode: 'READ_FAILED',
      },
    });
    expect(deriveHomeSurfaceState(readFailed)).toBe('DEGRADED');
  });

  it('D — missing wallet → Connect Wallet CTA to /wallet', () => {
    const wallets: WalletSummaryResponse = {
      status: 'READY',
      wallets: [],
      primaryWalletId: null,
      acceptedNetworkCode: 'TON_MAINNET',
      withdrawalCooldownUntil: null,
    };
    const cta = resolveHomeWalletCta({
      wallets,
      walletsQueryFailed: false,
      walletsQueryPending: false,
    });
    expect(cta).toEqual({ kind: 'connect', href: '/wallet' });
  });

  it('E — verified primary → Withdraw CTA to /wallet', () => {
    const wallets: WalletSummaryResponse = {
      status: 'READY',
      wallets: [
        {
          id: 'w1',
          chain: 'TON',
          networkCode: 'TON_MAINNET',
          friendlyAddress: 'EQ…',
          walletName: null,
          isPrimary: true,
          verified: true,
          verificationMethod: 'TON_PROOF',
          verifiedAt: '2026-09-28T00:00:00.000Z',
          becamePrimaryAt: '2026-09-28T00:00:00.000Z',
          disabledAt: null,
        },
      ],
      primaryWalletId: 'w1',
      acceptedNetworkCode: 'TON_MAINNET',
      withdrawalCooldownUntil: null,
    };
    const cta = resolveHomeWalletCta({
      wallets,
      walletsQueryFailed: false,
      walletsQueryPending: false,
    });
    expect(cta).toEqual({ kind: 'withdraw', href: '/wallet' });
  });

  it('F — wallet query failure does not fabricate verified state', () => {
    const cta = resolveHomeWalletCta({
      wallets: undefined,
      walletsQueryFailed: true,
      walletsQueryPending: false,
    });
    expect(cta.kind).toBe('open');
    expect(cta.href).toBe('/wallet');
  });

  it('G — active withdrawal Smart Action beats Earn', () => {
    const home = emptyHome({
      latestWithdrawal: {
        status: 'READY',
        data: {
          id: 'wd1',
          publicId: 'pub',
          state: 'QUEUED',
          netAmountAtomic: '1000',
          requestedAt: '2026-09-28T00:00:00.000Z',
        },
      },
      todayAds: {
        status: 'READY',
        data: {
          utcDay: '2026-09-28',
          providerCode: 'ADSGRAM',
          monetaryEligible: true,
          successRemaining: 2,
          requestRemaining: 3,
          requestUsageBasis: 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
          successUsageBasis: 'SUCCESSFUL_REWARD',
        },
      },
    });
    const earn: EarnSummaryResponse = {
      status: 'READY',
      asOf: '2026-09-28T00:00:00.000Z',
      providers: [
        {
          ...blockedProvider(),
          productionMonetaryStatus: 'APPROVED',
          monetaryEligible: true,
        },
      ],
    };
    const action = deriveHomeSmartAction({
      home,
      walletCtaKind: 'withdraw',
      earnSummary: earn,
    });
    expect(action?.kind).toBe('active_withdrawal');
  });

  it('H — blocked monetary Earn does not produce attractive monetary Smart Action', () => {
    const home = emptyHome({
      todayAds: {
        status: 'READY',
        data: {
          utcDay: '2026-09-28',
          providerCode: 'ADSGRAM',
          monetaryEligible: false,
          successRemaining: 25,
          requestRemaining: 30,
          requestUsageBasis: 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE',
          successUsageBasis: 'SUCCESSFUL_REWARD',
        },
      },
    });
    const earn: EarnSummaryResponse = {
      status: 'READY',
      asOf: '2026-09-28T00:00:00.000Z',
      providers: [blockedProvider()],
    };
    expect(isEarnOpportunityEligible({ todayAds: home.todayAds, earnSummary: earn })).toBe(false);
    const action = deriveHomeSmartAction({
      home,
      walletCtaKind: 'withdraw',
      earnSummary: earn,
    });
    expect(action).toBeNull();
  });

  it('I — Founder number comes only from membershipBrief', () => {
    const brief = emptyHome({
      membershipBrief: {
        status: 'READY',
        data: {
          active: true,
          planCode: 'FOUNDER',
          isFounder: true,
          founderNumber: 7,
        },
      },
    }).membershipBrief.data;
    expect(brief?.founderNumber).toBe(7);
    expect(brief?.isFounder).toBe(true);
  });

  it('J — Home source has no fake activity/referral/task rows', async () => {
    const home = await readFile(join(srcRoot, 'components/HomeScreen.tsx'), 'utf8');
    expect(home).not.toMatch(/Mikhail|Sofia|Nour|12\.840|0\.024/);
    expect(home).not.toMatch(/fake activity|Recent Activity|mockReferral/i);
    expect(home).not.toMatch(/missions\.data|referrals\.data/);
    expect(home).toMatch(/deriveHomeSurfaceState|HomeBalanceHero|HomeSmartAction/);
  });

  it('suppresses wallet Smart Action when Balance Hero already shows Connect', () => {
    const action = deriveHomeSmartAction({
      home: emptyHome(),
      walletCtaKind: 'connect',
      earnSummary: undefined,
      walletVerificationRequired: true,
    });
    expect(action?.kind).not.toBe('wallet_verification');
  });
});
