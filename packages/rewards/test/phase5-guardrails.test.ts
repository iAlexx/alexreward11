import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createExposureLimitVersion,
  createRewardQuote,
  createRewardRuleVersion,
  ensureSimulatedRewardProvider,
  setFeatureFlagEnabled,
  withLedgerTransaction,
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

describe.skipIf(phase5DatabaseUrl === '')('Phase 5 guardrails', () => {
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
      String(960_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
    await withLedgerTransaction(pool, async (client) => {
      await setFeatureFlagEnabled(client, {
        flagKey: 'GLOBAL_REWARDS_PAUSE',
        environment: 'LOCAL',
        enabled: false,
      });
      await setFeatureFlagEnabled(client, {
        flagKey: 'MEMBERSHIP_BONUS_PAUSE',
        environment: 'LOCAL',
        enabled: false,
      });
    });
  });

  it('blocks new quotes when GLOBAL_REWARDS_PAUSE is enabled', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);

    await withLedgerTransaction(pool, async (client) => {
      await setFeatureFlagEnabled(client, {
        flagKey: 'GLOBAL_REWARDS_PAUSE',
        environment: 'LOCAL',
        enabled: true,
      });
    });

    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED' });
  });

  it('blocks new quotes when exposure limit would be exceeded', async () => {
    const { providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '5000',
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);

    await withLedgerTransaction(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_GLOBAL_DAILY_REWARD_EXPENSE',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitAtomic: '1000',
        assetId,
        activate: true,
        reason: 'test-only exposure cap',
      });
    });

    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED' });
  });

  it('blocks new quotes when min expected margin is breached', async () => {
    await withLedgerTransaction(pool, async (client) => {
      const provider = await ensureSimulatedRewardProvider(client);
      await createRewardRuleVersion(client, {
        code: 'test-only-low-margin',
        sourceType: 'PROMOTION',
        assetId,
        providerId: provider.id,
        estimatedEcpmAtomic: '1000000',
        userShareBps: 9500,
        safetyFactorBps: 10000,
        minRewardAtomic: '1',
        maxRewardAtomic: '100000',
        quoteTtlSeconds: 60,
        activate: true,
      });
      await createExposureLimitVersion(client, {
        limitCode: 'MIN_EXPECTED_MARGIN_BPS',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitBps: 2000,
        activate: true,
        reason: 'test-only margin floor',
      });
    });

    const budgetPeriodId = await createTestOnlyBudget(pool, { assetId });
    const source = await newSimulatedSource(pool);
    const provider = await pool.query<{ id: string }>(
      `SELECT id FROM ad_providers WHERE code = 'SIMULATED_REWARD_SOURCE'`,
    );
    const providerId = provider.rows[0]?.id;
    if (providerId === undefined) throw new Error('SIMULATED_REWARD_SOURCE missing');

    await expect(
      createRewardQuote(pool, {
        userId,
        assetId,
        sourceType: 'PROMOTION',
        sourceId: source.sourceId,
        providerId,
        budgetPeriodId,
        evaluateMembershipBonus: false,
      }),
    ).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED' });
  });
});
