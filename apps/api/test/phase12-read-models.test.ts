/**
 * Phase 12 — Mini App read-model guarantees.
 *
 * These tests need no database: they exercise the pure projection and aggregation layer
 * that decides what a client is allowed to be told. The AdsGram inputs are the package's
 * real declared capabilities and the real monetary gate, not hand-written fixtures, so a
 * change to the approved policy data would surface here rather than being papered over.
 */
import {
  ADSGRAM_CAPABILITIES,
  ADSGRAM_CODE,
  ADSGRAM_NAME,
  ADSGRAM_OPEN_CLARIFICATION_CODES,
  ADSGRAM_PROVIDER_ID,
  evaluateProviderMonetaryEligibility,
  type EarnSummaryForUser,
} from '@alex-rewards/ads';
import type { UserLedgerBalances } from '@alex-rewards/ledger';
import { describe, expect, it } from 'vitest';

import { toEarnProviderCard } from '../src/ads/earn-summary.js';
import { toUserBalancesResponse } from '../src/me/balances.js';
import { settleDomain, unavailableDomain } from '../src/me/read-models.js';
import { ReferralsController } from '../src/referrals/referrals.controller.js';
import { TasksController } from '../src/tasks/tasks.controller.js';

const ASSET_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

function ledgerBalances(
  amounts: Partial<Record<keyof UserLedgerBalances['buckets'], string>> = {},
  accountExists = false,
): UserLedgerBalances {
  const bucket = (accountType: keyof UserLedgerBalances['buckets']) => ({
    accountType,
    accountId: accountExists ? ASSET_ID : null,
    amountAtomic: amounts[accountType] ?? '0',
    accountExists,
  });
  return {
    userId: USER_ID,
    assetId: ASSET_ID,
    assetSymbol: 'USDT',
    assetDecimals: 6,
    networkCode: 'TON_TESTNET',
    asOf: '2026-01-01T00:00:00.000Z',
    buckets: {
      USER_AVAILABLE_LIABILITY: bucket('USER_AVAILABLE_LIABILITY'),
      USER_PENDING_LIABILITY: bucket('USER_PENDING_LIABILITY'),
      USER_RESERVED_LIABILITY: bucket('USER_RESERVED_LIABILITY'),
    },
  };
}

describe('balances never invent a non-zero amount', () => {
  it('reports an authoritative zero for a user with no ledger accounts', () => {
    const response = toUserBalancesResponse(ledgerBalances(), '0');
    for (const bucket of [response.available, response.pending, response.reserved]) {
      expect(bucket.state).toBe('READY');
      expect(bucket.amountAtomic).toBe('0');
      expect(bucket.assetSymbol).toBe('USDT');
    }
  });

  it('echoes posted amounts exactly and never rounds or derives them', () => {
    const response = toUserBalancesResponse(
      ledgerBalances(
        {
          USER_AVAILABLE_LIABILITY: '1500',
          USER_PENDING_LIABILITY: '250',
          USER_RESERVED_LIABILITY: '0',
        },
        true,
      ),
      '1750',
    );
    expect(response.available.amountAtomic).toBe('1500');
    expect(response.pending.amountAtomic).toBe('250');
    expect(response.reserved.amountAtomic).toBe('0');
    expect(response.lifetimeEarned.amountAtomic).toBe('1750');
  });

  it('marks lifetime earned UNAVAILABLE rather than guessing when history cannot be read', () => {
    const response = toUserBalancesResponse(ledgerBalances(), null);
    expect(response.lifetimeEarned.state).toBe('UNAVAILABLE');
    expect(response.available.state).toBe('READY');
  });
});

describe('home tolerates partial domain failure', () => {
  it('contains a failing domain instead of failing the whole response', async () => {
    const [ok, failed, empty] = await Promise.all([
      settleDomain(async () => ({ value: 1 })),
      settleDomain(async () => {
        throw new Error('provider read exploded');
      }),
      settleDomain(async () => null),
    ]);

    expect(ok).toEqual({ status: 'READY', data: { value: 1 } });
    expect(failed).toEqual({ status: 'UNAVAILABLE', data: null, errorCode: 'READ_FAILED' });
    expect(empty).toEqual({ status: 'EMPTY', data: null, errorCode: 'NO_DATA' });
  });

  it('distinguishes a not-yet-approved engine from a runtime failure', () => {
    expect(unavailableDomain('ENGINE_NOT_ENABLED').errorCode).toBe('ENGINE_NOT_ENABLED');
  });
});

describe('earn summary reports AdsGram as BLOCKED', () => {
  const monetary = evaluateProviderMonetaryEligibility({
    providerId: ADSGRAM_PROVIDER_ID,
    providerCode: ADSGRAM_CODE,
    productionMonetaryStatus: ADSGRAM_CAPABILITIES.productionMonetaryStatus,
    cashRewardPolicyApproved: ADSGRAM_CAPABILITIES.cashRewardPolicyApproved,
    serverSignalAuthentication: ADSGRAM_CAPABILITIES.serverSignalAuthentication,
    sessionOrImpressionCorrelation: ADSGRAM_CAPABILITIES.sessionOrImpressionCorrelation,
    health: 'HEALTHY',
    openClarificationCount: ADSGRAM_OPEN_CLARIFICATION_CODES.length,
    requestHardLimitExceeded: false,
    successHardLimitExceeded: false,
  });

  const summary: EarnSummaryForUser = {
    providerId: ADSGRAM_PROVIDER_ID,
    providerCode: ADSGRAM_CODE,
    name: ADSGRAM_NAME,
    providerStatus: 'ACTIVE',
    rewardedUseAllowed: true,
    productionMonetaryStatus: ADSGRAM_CAPABILITIES.productionMonetaryStatus,
    monetary,
    health: {
      providerId: ADSGRAM_PROVIDER_ID,
      status: 'HEALTHY',
      reasonCode: 'PHASE11_FOUNDATION_DEFAULT',
      observedAt: '2026-01-01T00:00:00.000Z',
      detailsRedacted: {},
    },
    utcDay: '2026-01-01',
    asOf: '2026-01-01T00:00:00.000Z',
    request: {
      metric: 'REQUEST',
      configured: true,
      maxCount: 30,
      usedCount: 4,
      remaining: 26,
      decidingRuleId: 'a11a11a1-0000-4000-8000-0000000011a1',
      decidingRuleVersion: 1,
    },
    success: {
      metric: 'SUCCESS',
      configured: true,
      maxCount: 25,
      usedCount: 25,
      remaining: 0,
      decidingRuleId: 'a11a11a1-0000-4000-8000-0000000011a2',
      decidingRuleVersion: 1,
    },
    blockIdPublic: null,
    authorizeAssetId: null,
    authorizeBudgetPeriodId: null,
  };

  it('never presents a BLOCKED provider as monetarily eligible', () => {
    const card = toEarnProviderCard(summary);
    expect(card.productionMonetaryStatus).toBe('BLOCKED');
    expect(card.monetaryEligible).toBe(false);
    expect(card.reasonCodes).toContain('PRODUCTION_MONETARY_STATUS_BLOCKED');
    expect(card.reasonCodes).toContain('OPEN_CLARIFICATION_ITEMS');
  });

  it('exposes versioned limit remainders and no server-side configuration', () => {
    const card = toEarnProviderCard(summary);
    expect(card.opportunitiesRemaining.request.remaining).toBe(26);
    expect(card.opportunitiesRemaining.success.remaining).toBe(0);
    expect(card.opportunitiesRemaining.success.decidingRuleId).not.toBeNull();

    const serialized = JSON.stringify(card);
    expect(serialized).not.toMatch(/secret|credential|server_config|serverConfig|rewardUrl/i);
    expect(Object.keys(card).sort()).toEqual([
      'authorizeAssetId',
      'authorizeBudgetPeriodId',
      'blockIdPublic',
      'health',
      'monetaryEligible',
      'name',
      'opportunitiesRemaining',
      'productionMonetaryStatus',
      'providerCode',
      'reasonCodes',
      'rewardedUseAllowed',
      'utcDay',
    ]);
  });
});

describe('not-yet-approved engines answer honestly', () => {
  it('reports tasks as UNAVAILABLE with an empty item list', () => {
    expect(new TasksController().listTasks()).toEqual({
      status: 'UNAVAILABLE',
      items: [],
      reasonCode: 'ENGINE_NOT_ENABLED',
    });
  });

  it('reports referrals as UNAVAILABLE with no fabricated counts', () => {
    const summary = new ReferralsController().getSummary();
    expect(summary).toEqual({
      status: 'UNAVAILABLE',
      data: null,
      reasonCode: 'ENGINE_NOT_ENABLED',
    });
  });
});
