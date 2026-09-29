import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  activateRewardRuleVersion,
  createRewardQuote,
  createRewardRuleVersion,
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

describe.skipIf(phase5DatabaseUrl === '')('Phase 15 reward_rules.referral_eligible', () => {
  let pool: Pool;
  let assetId: string;

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
  });

  it('allows DRAFT with null referral_eligible; rejects ACTIVE create without it', async () => {
    const draft = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'phase15-draft-null',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        activate: false,
      }),
    );
    expect(draft.status).toBe('DRAFT');
    expect(draft.referralEligible).toBeNull();

    await expect(
      withLedgerTransaction(pool, (client) =>
        createRewardRuleVersion(client, {
          code: 'phase15-active-missing',
          sourceType: 'PROMOTION',
          assetId,
          fixedRewardAtomic: '100',
          activate: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects activate when referral_eligible is NULL; accepts explicit false/true', async () => {
    const draftNull = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'phase15-activate-null',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        activate: false,
      }),
    );
    await expect(
      withLedgerTransaction(pool, (client) => activateRewardRuleVersion(client, draftNull.id)),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const draftFalse = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'phase15-activate-false',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '100',
        activate: false,
        referralEligible: false,
      }),
    );
    const activated = await withLedgerTransaction(pool, (client) =>
      activateRewardRuleVersion(client, draftFalse.id),
    );
    expect(activated.status).toBe('ACTIVE');
    expect(activated.referralEligible).toBe(false);

    const activeTrue = await withLedgerTransaction(pool, (client) =>
      createRewardRuleVersion(client, {
        code: 'phase15-active-true',
        sourceType: 'PROMOTION',
        assetId,
        fixedRewardAtomic: '50',
        activate: true,
        referralEligible: true,
      }),
    );
    expect(activeTrue.referralEligible).toBe(true);
  });

  it('historical NULL ACTIVE rows remain readable; referral_eligible is immutable', async () => {
    // Simulate a pre-migration ACTIVE row: drop NOT VALID check, insert NULL ACTIVE,
    // restore constraint (still enforced on subsequent writes).
    await pool.query(
      `ALTER TABLE reward_rules DROP CONSTRAINT reward_rules_active_requires_referral_eligible`,
    );
    let id = '';
    try {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO reward_rules (
           code, rule_version, source_type, asset_id, fixed_reward_atomic,
           pending_hold_seconds, quote_ttl_seconds, status, referral_eligible
         ) VALUES (
           'phase15-historical', 1, 'PROMOTION'::reward_source_type, $1::uuid, 100,
           0, 60, 'ACTIVE'::rule_version_status, NULL
         )
         RETURNING id`,
        [assetId],
      );
      id = inserted.rows[0]!.id;
    } finally {
      await pool.query(`
        ALTER TABLE reward_rules
          ADD CONSTRAINT reward_rules_active_requires_referral_eligible
            CHECK (status <> 'ACTIVE' OR referral_eligible IS NOT NULL)
            NOT VALID
      `);
    }

    const row = await pool.query<{ referral_eligible: boolean | null; status: string }>(
      `SELECT referral_eligible, status::text AS status FROM reward_rules WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('ACTIVE');
    expect(row.rows[0]?.referral_eligible).toBeNull();

    await expect(
      pool.query(`UPDATE reward_rules SET referral_eligible = false WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable/i);
  });

  it('pins referralEligible provenance through quote applied_economics rule id', async () => {
    const userId = await createTestUser(
      pool,
      String(915_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
    const { ruleId, providerId } = await createTestOnlyPromotionRule(pool, {
      assetId,
      fixedRewardAtomic: '1000',
      pendingHoldSeconds: 0,
    });
    const budgetPeriodId = await createTestOnlyBudget(pool, {
      assetId,
      budgetAtomic: '1000000',
    });
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

    expect(quote.rewardRuleId).toBe(ruleId);
    const rule = await pool.query<{ referral_eligible: boolean | null }>(
      `SELECT referral_eligible FROM reward_rules WHERE id = $1`,
      [ruleId],
    );
    expect(rule.rows[0]?.referral_eligible).toBe(false);
    expect(quote.appliedEconomics.rewardRuleId).toBe(ruleId);
  });
});
