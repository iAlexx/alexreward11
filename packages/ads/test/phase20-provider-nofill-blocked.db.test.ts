/**
 * Phase 20 Step 3 — AdsGram observation path with monetary BLOCKED.
 * Disposable DB only. Does NOT enable production money.
 *
 * Gate: PHASE20_DATABASE_URL (or PHASE20_STEP3_REQUIRE_DB_GATES=1 required),
 * or PHASE20_ADS_TESTS=1 + DATABASE_URL, or PHASE11_DATABASE_URL.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adRewardIdempotencyKey,
  attemptVerifyAndIssueAdReward,
  authorizeRewardedAdSession,
  getProvider,
  recordAdSessionOutcome,
  recordClientSignal,
  recordProviderSignal,
  type AuthorizeAdResult,
} from '../src/index.js';
import {
  ADSGRAM_CODE,
  ADSGRAM_PROVIDER_ID,
  countLedgerTransactions,
  countLedgerTransactionsForQuote,
  createAdBudgetPeriod,
  createAdRewardRule,
  createTestUser,
  readQuoteStatus,
  readSessionRow,
  resetAndMigrate,
  usdtAssetId,
} from './harness.js';

function resolvePhase20AdsDatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP3_REQUIRE_DB_GATES === '1') {
    throw new Error(
      'PHASE20_STEP3_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL (disposable *_test DB)',
    );
  }
  if (process.env.PHASE20_ADS_TESTS === '1') {
    return process.env.DATABASE_URL ?? '';
  }
  return process.env.PHASE11_DATABASE_URL ?? '';
}

const dbUrl = resolvePhase20AdsDatabaseUrl();

describe.skipIf(dbUrl === '')('Phase 20 AdsGram provider/no-fill/BLOCKED (DB)', () => {
  let pool!: Pool;
  let assetId!: string;
  let budgetPeriodId!: string;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    assetId = await usdtAssetId(pool);
    budgetPeriodId = await createAdBudgetPeriod(pool, { assetId });
    await createAdRewardRule(pool, { assetId, providerId: ADSGRAM_PROVIDER_ID });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function authorize(userId: string): Promise<AuthorizeAdResult> {
    return authorizeRewardedAdSession(pool, {
      providerCode: ADSGRAM_CODE,
      userId,
      assetId,
      budgetPeriodId,
      adUnitId: null,
      countryCode: null,
      environment: 'LOCAL',
      evaluateMembershipBonus: false,
    });
  }

  async function playClientToCompletion(adSessionId: string, userId: string): Promise<void> {
    for (const event of ['REQUEST_APPROVED', 'AD_LOADED', 'AD_STARTED', 'CLIENT_COMPLETION']) {
      await recordClientSignal(pool, { adSessionId, userId, eventType: event });
    }
  }

  async function rewardEventCount(): Promise<number> {
    const r = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM reward_events`);
    return r.rows[0]!.c;
  }

  async function availableBalanceSum(): Promise<string> {
    const r = await pool.query<{ s: string }>(
      `SELECT coalesce(sum(balance_atomic), 0)::text AS s FROM ledger_account_balances`,
    );
    return r.rows[0]!.s;
  }

  it('AdsGram capabilities remain authenticity NONE / monetaryAuthority false / BLOCKED', async () => {
    const provider = getProvider(ADSGRAM_CODE);
    const caps = provider.getCapabilities();
    expect(caps.productionMonetaryStatus).toBe('BLOCKED');
    expect(caps.serverSignalAuthentication).toBe('NONE');
    expect(caps.cashRewardPolicyApproved).toBe(false);

    const verified = await provider.verifyServerSignal(
      { telegramUserId: '1', blockId: null, adSessionId: null, providerEventId: null },
      { providerId: ADSGRAM_PROVIDER_ID, receivedAt: new Date() },
    );
    expect(verified.authenticity).toBe('UNVERIFIED');
    expect(verified.authenticationMethod).toBe('NONE');
    expect(verified.authenticationStrength).toBe('NONE');
    expect(verified.monetaryAuthority).toBe(false);
  });

  it('NO_FILL is terminal, releases quote, no reward/ledger/balance change; retry immutable', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });

    const ledgerBefore = await countLedgerTransactions(pool);
    const rewardsBefore = await rewardEventCount();
    const balBefore = await availableBalanceSum();

    const outcome = await recordAdSessionOutcome(pool, {
      adSessionId: session.adSessionId,
      userId,
      outcome: 'NO_FILL',
      failureCode: 'NO_FILL',
    });
    expect(outcome.state).toBe('NO_FILL');
    expect(outcome.quoteReleased).toBe(true);
    expect(await readQuoteStatus(pool, session.rewardQuoteId)).toBe('CANCELLED');

    const late = await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'CLIENT_COMPLETION',
    });
    expect(late.reasonCodes).toContain('TERMINAL_STATE_IMMUTABLE');
    expect((await readSessionRow(pool, session.adSessionId)).state).toBe('NO_FILL');

    const again = await recordAdSessionOutcome(pool, {
      adSessionId: session.adSessionId,
      userId,
      outcome: 'NO_FILL',
      failureCode: 'NO_FILL',
    });
    expect(again.state).toBe('NO_FILL');

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: session.adSessionId,
        userId,
        idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });

    expect(await countLedgerTransactionsForQuote(pool, session.rewardQuoteId)).toBe(0);
    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    expect(await rewardEventCount()).toBe(rewardsBefore);
    expect(await availableBalanceSum()).toBe(balBefore);
  });

  it.each([
    ['LOAD_FAILURE', 'FAILED'],
    ['START_FAILURE', 'FAILED'],
    ['TECHNICAL_FAILURE', 'FAILED'],
    ['USER_SKIPPED', 'SKIPPED'],
  ] as const)('%s → %s terminal, no money', async (eventType, expectedState) => {
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType: 'REQUEST_APPROVED',
    });

    const ledgerBefore = await countLedgerTransactions(pool);
    const rewardsBefore = await rewardEventCount();
    const balBefore = await availableBalanceSum();

    const signal = await recordClientSignal(pool, {
      adSessionId: session.adSessionId,
      userId,
      eventType,
    });
    expect(signal.state).toBe(expectedState);

    await expect(
      attemptVerifyAndIssueAdReward(pool, {
        adSessionId: session.adSessionId,
        userId,
        idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });

    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    expect(await rewardEventCount()).toBe(rewardsBefore);
    expect(await availableBalanceSum()).toBe(balBefore);
  });

  it('CLIENT_COMPLETION is evidence only; attempt-verify refuses money while BLOCKED', async () => {
    const userId = await createTestUser(pool);
    const session = await authorize(userId);
    await playClientToCompletion(session.adSessionId, userId);

    const mid = await readSessionRow(pool, session.adSessionId);
    expect(mid.state).not.toBe('REWARDED');
    expect(mid.state).not.toBe('VERIFIED');

    await recordProviderSignal(pool, {
      adSessionId: session.adSessionId,
      providerCode: ADSGRAM_CODE,
      eventType: 'REWARD',
      providerEventId: `evt-p20-${session.adSessionId}`,
      authenticity: 'VERIFIED',
      correlation: 'CORRELATED',
    });

    const ledgerBefore = await countLedgerTransactions(pool);
    const rewardsBefore = await rewardEventCount();
    const balBefore = await availableBalanceSum();

    const attempt = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });

    expect(attempt.issued).toBe(false);
    expect(attempt.reward).toBeNull();
    expect(attempt.monetary?.eligible).toBe(false);
    expect(attempt.monetary?.status).toBe('BLOCKED');
    expect(attempt.monetary?.reasonCodes).toEqual(
      expect.arrayContaining([
        'PRODUCTION_MONETARY_STATUS_BLOCKED',
        'SERVER_SIGNAL_AUTHENTICATION_INSUFFICIENT',
      ]),
    );

    const second = await attemptVerifyAndIssueAdReward(pool, {
      adSessionId: session.adSessionId,
      userId,
      idempotencyKey: adRewardIdempotencyKey(session.adSessionId),
    });
    expect(second.issued).toBe(false);
    expect(second.monetary?.status).toBe('BLOCKED');

    expect(await countLedgerTransactions(pool)).toBe(ledgerBefore);
    expect(await rewardEventCount()).toBe(rewardsBefore);
    expect(await availableBalanceSum()).toBe(balBefore);
  });

  it('client cannot supply reward amount or monetary authenticity on ads HTTP surface', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const http = readFileSync(join(process.cwd(), '../../apps/api/src/ads/http.ts'), 'utf8');
    expect(http).toMatch(/assertNoClientAuthorityFields/);
    expect(http).toMatch(/amountAtomic/);
    expect(http).toMatch(/productionMonetaryStatus/);
    expect(http).toMatch(/authenticity/);
  });
});