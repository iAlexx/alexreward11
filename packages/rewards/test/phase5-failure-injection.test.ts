import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withLedgerTransaction } from '@alex-rewards/ledger';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  insertOutboxEvent,
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

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 failure injection', () => {
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
      String(970_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('rolls back quote + reservation + outbox when thrown after partial work', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '900',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);

    await expect(
      withLedgerTransaction(pool, async (client) => {
        // Drive quote creation internals by calling public API pieces on the same client.
        const quote = await createRewardQuote(client, {
          userId,
          assetId,
          sourceType: 'PROMOTION',
          sourceId: source.sourceId,
          providerId,
          budgetPeriodId,
          evaluateMembershipBonus: false,
        });
        await insertOutboxEvent(client, {
          aggregateType: 'reward_quote',
          aggregateId: quote.quoteId,
          eventType: 'reward_quote.failure_injection',
          dedupeKey: `failure-injection/${quote.quoteId}`,
          payload: { quoteId: quote.quoteId },
        });
        throw new Error('injected failure after quote+outbox');
      }),
    ).rejects.toThrow(/injected failure/);

    const quotes = await pool.query(`SELECT id FROM reward_quotes`);
    expect(quotes.rowCount).toBe(0);
    const reservations = await pool.query(`SELECT id FROM reward_budget_reservations`);
    expect(reservations.rowCount).toBe(0);
    const period = await pool.query<{ reserved_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('0');
    const outbox = await pool.query(
      `SELECT id FROM outbox_events WHERE event_type = 'reward_quote.failure_injection'`,
    );
    expect(outbox.rowCount).toBe(0);
  });

  it('rolls back issuance when failure occurs after ledger post attempt setup', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1100',
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

    await expect(
      withLedgerTransaction(pool, async (client) => {
        const { issueSimulatedReward } = await import('../src/index.js');
        // Nested call reuses the same client transaction (withLedgerTransaction passthrough).
        await issueSimulatedReward(client, {
          quoteId: quote.quoteId,
          userId,
          idempotencyKey: `fail-issue-${quote.quoteId}`,
        });
        throw new Error('injected failure after issuance');
      }),
    ).rejects.toThrow(/injected failure/);

    const events = await pool.query(`SELECT id FROM reward_events`);
    expect(events.rowCount).toBe(0);
    const ledger = await pool.query(`SELECT id FROM ledger_transactions`);
    expect(ledger.rowCount).toBe(0);
    const quoteRow = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM reward_quotes WHERE id = $1`,
      [quote.quoteId],
    );
    expect(quoteRow.rows[0]?.status).toBe('OPEN');
    const period = await pool.query<{ reserved_atomic: string; consumed_atomic: string }>(
      `SELECT reserved_atomic::text AS reserved_atomic, consumed_atomic::text AS consumed_atomic
       FROM reward_budget_periods WHERE id = $1`,
      [budgetPeriodId],
    );
    expect(period.rows[0]?.reserved_atomic).toBe('1100');
    expect(period.rows[0]?.consumed_atomic).toBe('0');
  });
});
