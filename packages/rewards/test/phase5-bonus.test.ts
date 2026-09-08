import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  issueSimulatedReward,
  requireBonusUnavailablePolicy,
  RewardDomainError,
} from '../src/index.js';
import {
  createFounderBonusFixture,
  createTestOnlyBudget,
  createTestOnlyPromotionRule,
  createTestUser,
  newSimulatedSource,
  phase5DatabaseUrl,
  resetAndMigrate,
  truncateRewardTables,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 membership bonus', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateRewardTables(pool);
    userId = await createTestUser(
      pool,
      String(940_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('requires bonusUnavailablePolicy when bonus evaluation is in scope', () => {
    expect(() => requireBonusUnavailablePolicy(true, null)).toThrow(RewardDomainError);
    expect(() => requireBonusUnavailablePolicy(true, undefined)).toThrow(/bonusUnavailablePolicy/);
    expect(requireBonusUnavailablePolicy(true, 'BASE_REWARD_ONLY')).toBe('BASE_REWARD_ONLY');
  });

  it('quotes and issues Founder bonus separately with null quote_id on bonus event', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
      pendingHoldSeconds: 60,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const founder = await createFounderBonusFixture(pool, { userId, assetId, bonusBps: 500 });
    const source = await newSimulatedSource(pool);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      membershipBonusBudgetPeriodId: founder.bonusBudgetPeriodId,
    });

    expect(quote.baseAmountAtomic).toBe('1000');
    expect(quote.membershipBonusAmountAtomic).toBe('50'); // FLOOR(1000 * 500 / 10000)
    expect(quote.amountAtomic).toBe('1050');
    expect(quote.appliedEconomics.bonusBps).toBe(500);
    expect(quote.appliedEconomics.membershipId).toBe(founder.membershipId);

    await completeSimulatedRewardSource(pool, {
      sourceId: source.sourceId,
      quoteId: quote.quoteId,
      userId,
    });

    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: `bonus-issue-${quote.quoteId}`,
    });

    expect(issued.bonusRewardEventId).not.toBeNull();
    expect(issued.bonusLedgerTransactionId).not.toBeNull();

    const baseEvent = await pool.query<{ reward_quote_id: string | null; source_type: string }>(
      `SELECT reward_quote_id, source_type::text AS source_type FROM reward_events WHERE id = $1`,
      [issued.baseRewardEventId],
    );
    expect(baseEvent.rows[0]?.reward_quote_id).toBe(quote.quoteId);
    expect(baseEvent.rows[0]?.source_type).toBe('PROMOTION');

    const bonusEvent = await pool.query<{
      reward_quote_id: string | null;
      source_type: string;
      amount_atomic: string;
    }>(
      `SELECT reward_quote_id, source_type::text AS source_type, amount_atomic::text AS amount_atomic
       FROM reward_events WHERE id = $1`,
      [issued.bonusRewardEventId],
    );
    expect(bonusEvent.rows[0]?.reward_quote_id).toBeNull();
    expect(bonusEvent.rows[0]?.source_type).toBe('MEMBERSHIP_BONUS');
    expect(bonusEvent.rows[0]?.amount_atomic).toBe('50');

    const bonusLedger = await pool.query<{ transaction_type: string }>(
      `SELECT transaction_type::text AS transaction_type FROM ledger_transactions WHERE id = $1`,
      [issued.bonusLedgerTransactionId],
    );
    expect(bonusLedger.rows[0]?.transaction_type).toBe('MEMBERSHIP_BONUS_ISSUANCE');

    const reservation = await pool.query<{
      originating_reward_event_id: string;
      bonus_reward_event_id: string;
      state: string;
    }>(
      `SELECT originating_reward_event_id, bonus_reward_event_id, state::text AS state
       FROM membership_bonus_budget_reservations WHERE reward_quote_id = $1`,
      [quote.quoteId],
    );
    expect(reservation.rows[0]?.state).toBe('CONSUMED');
    expect(reservation.rows[0]?.originating_reward_event_id).toBe(issued.baseRewardEventId);
    expect(reservation.rows[0]?.bonus_reward_event_id).toBe(issued.bonusRewardEventId);
  });

  it('BASE_REWARD_ONLY continues when bonus budget is missing', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    await createFounderBonusFixture(pool, { userId, assetId });
    const source = await newSimulatedSource(pool);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: true,
      bonusUnavailablePolicy: 'BASE_REWARD_ONLY',
      // no membershipBonusBudgetPeriodId
    });

    expect(quote.baseAmountAtomic).toBe('1000');
    expect(quote.membershipBonusAmountAtomic).toBe('0');
  });

  it('BLOCK_QUOTE_BEFORE_START fails closed when bonus budget is missing', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    await createFounderBonusFixture(pool, { userId, assetId });
    const source = await newSimulatedSource(pool);

    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: true,
        bonusUnavailablePolicy: 'BLOCK_QUOTE_BEFORE_START',
      }),
    ).rejects.toMatchObject({ code: 'BONUS_BLOCKED' });
  });
});
