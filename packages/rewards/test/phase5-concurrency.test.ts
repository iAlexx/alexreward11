import { randomUUID } from 'node:crypto';

import { checkLedgerInvariants } from '@alex-rewards/ledger';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  completeSimulatedRewardSource,
  createRewardQuote,
  issueSimulatedReward,
  matureRewardEvent,
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

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 concurrency + Phase 4 composition', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase5DatabaseUrl);
    pool = new Pool({ connectionString: phase5DatabaseUrl, max: 10 });
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

  it('concurrent final budget slot allows only one quote', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '800',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      budgetAtomic: '800',
    });
    const a = await newSimulatedSource(pool);
    const b = await newSimulatedSource(pool);
    const results = await Promise.allSettled([
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: a.sourceId,
        providerId,
        budgetPeriodId,
      }),
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: b.sourceId,
        providerId,
        budgetPeriodId,
      }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });

  it('duplicate issuance recovers original result exactly once economically', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '400',
      pendingHoldSeconds: 30,
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
    });
    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
    });
    const key = `issue-${randomUUID()}`;
    const first = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: key,
    });
    const second = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: key,
    });
    expect(second.baseRewardEventId).toBe(first.baseRewardEventId);
    expect(second.baseLedgerTransactionId).toBe(first.baseLedgerTransactionId);
    const events = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM reward_events WHERE reward_quote_id = $1`,
      [quote.quoteId],
    );
    expect(events.rows[0]?.c).toBe(1);
  });

  it('concurrent maturity posts exactly one economic movement', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '250',
      pendingHoldSeconds: 1,
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
    });
    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
    });
    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: `mat-${randomUUID()}`,
      asOf: new Date(),
    });
    const due = new Date(Date.now() + 2_000);
    await pool.query(`UPDATE reward_events SET pending_until = $2 WHERE id = $1`, [
      issued.baseRewardEventId,
      due.toISOString(),
    ]);
    // Make due now for maturity
    await pool.query(
      `UPDATE reward_events SET pending_until = now() - interval '1 second' WHERE id = $1`,
      [issued.baseRewardEventId],
    );
    const results = await Promise.all([
      matureRewardEvent(pool, { rewardEventId: issued.baseRewardEventId }),
      matureRewardEvent(pool, { rewardEventId: issued.baseRewardEventId }),
    ]);
    expect(results[0].ledgerTransactionId).toBe(results[1].ledgerTransactionId);
    const matured = results.filter((item) => item.created);
    expect(matured.length).toBeLessThanOrEqual(1);
  });

  it('base+bonus same outer txn keeps Phase 4 invariants PASS after dual maturity', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
      pendingHoldSeconds: 1,
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
    expect(quote.membershipBonusAmountAtomic).toBe('50');
    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
    });
    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: `bonus-atom-${randomUUID()}`,
    });
    expect(issued.bonusRewardEventId).not.toBeNull();

    // Same-timestamp multi-post already happened at issuance; invariants must pass.
    expect((await checkLedgerInvariants(pool)).ok).toBe(true);

    await pool.query(
      `UPDATE reward_events SET pending_until = now() - interval '1 second'
       WHERE id = ANY($1::uuid[])`,
      [[issued.baseRewardEventId, issued.bonusRewardEventId]],
    );
    await matureRewardEvent(pool, { rewardEventId: issued.baseRewardEventId });
    await matureRewardEvent(pool, { rewardEventId: issued.bonusRewardEventId! });

    const available = await pool.query<{ balance_atomic: string }>(
      `SELECT b.balance_atomic::text AS balance_atomic
       FROM ledger_account_balances b
       JOIN ledger_accounts a ON a.id = b.ledger_account_id
       WHERE a.owner_id = $1 AND a.account_type = 'USER_AVAILABLE_LIABILITY'`,
      [userId],
    );
    expect(available.rows[0]?.balance_atomic).toBe('1050');
    expect((await checkLedgerInvariants(pool)).ok).toBe(true);
  });

  it('frozen started quote keeps old bonus after new benefit version activation', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '2000',
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
    expect(quote.membershipBonusAmountAtomic).toBe('100');
    await completeSimulatedRewardSource(pool, {
      quoteId: quote.quoteId,
      sourceId: source.sourceId,
      userId,
    });

    // Supersede prior ACTIVE benefit mapping, then activate a higher-bps version.
    // Frozen quote must still issue the originally reserved 100.
    const { createBenefitRuleVersion, bindPlanEntitlement, withLedgerTransaction } =
      await import('../src/index.js');
    await withLedgerTransaction(pool, async (client) => {
      await client.query(
        `UPDATE membership_plan_entitlements
         SET status = 'SUPERSEDED', valid_to = now()
         WHERE membership_plan_id = $1 AND entitlement_id = $2 AND status = 'ACTIVE'`,
        [founder.planId, founder.entitlementId],
      );
      await client.query(
        `UPDATE membership_benefit_rule_versions
         SET status = 'SUPERSEDED', effective_to = now()
         WHERE id = $1`,
        [founder.benefitRuleVersionId],
      );
      const newer = await createBenefitRuleVersion(client, {
        entitlementId: founder.entitlementId,
        membershipPlanId: founder.planId,
        ruleVersion: 2,
        valueBps: 900,
        reason: 'test-only supersede after quote freeze',
        activate: true,
      });
      await bindPlanEntitlement(client, {
        membershipPlanId: founder.planId,
        entitlementId: founder.entitlementId,
        ruleVersionId: newer.id,
      });
    });

    const issued = await issueSimulatedReward(pool, {
      quoteId: quote.quoteId,
      userId,
      idempotencyKey: `freeze-${randomUUID()}`,
    });
    expect(issued.membershipBonusAmountAtomic).toBe('100');
    expect(issued.bonusRewardEventId).not.toBeNull();
  });
});
