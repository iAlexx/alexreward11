import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getOrCreateLedgerAccount, withLedgerTransaction } from '@alex-rewards/ledger';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  issueSimulatedReward,
  matureRewardEvent,
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

async function accountBalance(pool: Pool, accountId: string): Promise<bigint> {
  const result = await pool.query<{ balance_atomic: string }>(
    `SELECT balance_atomic::text AS balance_atomic FROM ledger_account_balances WHERE ledger_account_id = $1`,
    [accountId],
  );
  return BigInt(result.rows[0]?.balance_atomic ?? '0');
}

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 maturity', () => {
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
      String(950_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  async function issuePending(amount: string): Promise<{ rewardEventId: string; issuedAt: Date }> {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: amount,
      pendingHoldSeconds: 1,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);
    const asOf = new Date();
    const quote = await createRewardQuote(pool, {
      userId,
      assetId,
      sourceType: 'PROMOTION',
      sourceId: source.sourceId,
      providerId,
      budgetPeriodId,
      asOf,
      evaluateMembershipBonus: false,
    });
    await completeSimulatedRewardSource(pool, {
      sourceId: source.sourceId,
      quoteId: quote.quoteId,
      userId,
      completedAt: asOf,
    });
    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      asOf,
      idempotencyKey: `maturity-${quote.quoteId}`,
    });
    return { rewardEventId: issued.baseRewardEventId, issuedAt: asOf };
  }

  it('matures pending reward idempotently with business ref reward-maturity/{id}', async () => {
    const { rewardEventId, issuedAt } = await issuePending('1200');
    const due = new Date(issuedAt.getTime() + 2_000);

    const first = await matureRewardEvent(pool, { rewardEventId, asOf: due });
    expect(first.created).toBe(true);
    expect(first.state).toBe('AVAILABLE');

    const second = await matureRewardEvent(pool, { rewardEventId, asOf: due });
    expect(second.created).toBe(false);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);

    const ledger = await pool.query<{
      transaction_type: string;
      business_reference_type: string;
      business_reference_id: string;
    }>(
      `SELECT transaction_type::text AS transaction_type,
              business_reference_type, business_reference_id
       FROM ledger_transactions WHERE id = $1`,
      [first.ledgerTransactionId],
    );
    expect(ledger.rows[0]?.transaction_type).toBe('REWARD_MATURITY');
    expect(ledger.rows[0]?.business_reference_type).toBe('reward-maturity');
    expect(ledger.rows[0]?.business_reference_id).toBe(rewardEventId);

    const accounts = await withLedgerTransaction(pool, async (client) => {
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      return { pendingId: pending.id, availableId: available.id };
    });
    expect(await accountBalance(pool, accounts.pendingId)).toBe(0n);
    expect(await accountBalance(pool, accounts.availableId)).toBe(1200n);
  });

  it('rejects maturity before pending_until', async () => {
    const { rewardEventId, issuedAt } = await issuePending('900');
    await expect(
      matureRewardEvent(pool, {
        rewardEventId,
        asOf: new Date(issuedAt.getTime() + 500),
      }),
    ).rejects.toMatchObject({ code: 'MATURITY_NOT_DUE' });
  });
});
