import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  issueSimulatedReward,
  DEFAULT_PENDING_HOLD_SECONDS,
} from '../src/index.js';
import {
  createTestOnlyBudget,
  createTestOnlyPromotionRule,
  createTestUser,
  newSimulatedSource,
  phase5DatabaseUrl,
  resetAndMigrate,
  truncateRewardTables,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 simulated issuance', () => {
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
      String(930_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('issues base reward through ledger and consumes reservation', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '2000',
      pendingHoldSeconds: 0,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);

    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });

    await completeSimulatedRewardSource(pool, {
      sourceId: source.sourceId,
      quoteId: quote.quoteId,
      userId,
    });

    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: `issue-${quote.quoteId}`,
    });

    expect(issued.baseAmountAtomic).toBe('2000');
    expect(issued.bonusRewardEventId).toBeNull();
    expect(issued.pendingUntil).toBeTruthy();

    const pendingHoldMs =
      new Date(issued.pendingUntil).getTime() - Date.parse(quote.appliedEconomics.quoteCreatedAt);
    // pending_hold_seconds=0 → conservative 86400 default for new/untrusted
    expect(pendingHoldMs).toBeGreaterThanOrEqual((DEFAULT_PENDING_HOLD_SECONDS - 5) * 1000);

    const event = await pool.query<{
      state: string;
      reward_quote_id: string;
      amount_atomic: string;
    }>(
      `SELECT state::text AS state, reward_quote_id, amount_atomic::text AS amount_atomic
       FROM reward_events WHERE id = $1`,
      [issued.baseRewardEventId],
    );
    expect(event.rows[0]?.state).toBe('PENDING');
    expect(event.rows[0]?.reward_quote_id).toBe(quote.quoteId);
    expect(event.rows[0]?.amount_atomic).toBe('2000');

    const ledger = await pool.query<{ transaction_type: string }>(
      `SELECT transaction_type::text AS transaction_type FROM ledger_transactions WHERE id = $1`,
      [issued.baseLedgerTransactionId],
    );
    expect(ledger.rows[0]?.transaction_type).toBe('REWARD_ISSUANCE');

    const period = await pool.query<{ reserved_atomic: string; consumed_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic, consumed_atomic::text AS consumed_atomic
       FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('0');
    expect(period.rows[0]?.consumed_atomic).toBe('2000');

    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE dedupe_key = $1`,
      [`reward-event-issued/${issued.baseRewardEventId}`],
    );
    expect(outbox.rows[0]?.event_type).toBe('reward_event.issued');
  });

  it('refuses issuance before simulated source start', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      evaluateMembershipBonus: false,
    });

    await expect(
      issueSimulatedReward(pool, {
        quoteId: quote.quoteId,
        userId,
        idempotencyKey: 'too-early',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_READY' });
  });

  it('keeps SIMULATED_REWARD_SOURCE production_monetary_status BLOCKED', async () => {
    const source = await newSimulatedSource(pool);
    const provider = await pool.query<{ production_monetary_status: string; code: string }>(
      `SELECT production_monetary_status::text AS production_monetary_status, code
       FROM ad_providers WHERE id = $1`,
      [source.providerId],
    );
    expect(provider.rows[0]?.code).toBe('SIMULATED_REWARD_SOURCE');
    expect(provider.rows[0]?.production_monetary_status).toBe('BLOCKED');
  });
});
