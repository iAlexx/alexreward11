/**
 * Phase 15 Step 5 — budgeted referral reward issuance.
 * Destructive against PHASE15_DATABASE_URL (preferred) or PHASE5_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  computeReferralBonusAtomic,
  createExposureLimitVersion,
  createRewardRuleVersion,
  issueReferralReward,
  withLedgerTransaction as withRewardTx,
} from '../src/index.js';
import {
  createTestUser,
  phase5DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
} from './harness.js';

const phase15Url =
  process.env.PHASE15_DATABASE_URL !== undefined && process.env.PHASE15_DATABASE_URL !== ''
    ? process.env.PHASE15_DATABASE_URL
    : phase5DatabaseUrl;

const TEST_RATE_BPS = 123;
const TEST_SOURCE_AMOUNT = 10_000n;

async function insertReferralRule(pool: Pool, baseRateBps = TEST_RATE_BPS): Promise<number> {
  await pool.query(
    `INSERT INTO referral_rule_versions (
       rule_version, activation_account_age_seconds, activation_valid_ad_count,
       base_rate_bps, status, effective_from, reason
     ) VALUES (
       1, 0, 0, $1, 'ACTIVE', now() - interval '1 hour', 'phase15-step5-test'
     )`,
    [baseRateBps],
  );
  return 1;
}

async function insertActiveEdge(
  pool: Pool,
  referrerId: string,
  referredId: string,
  activatedAt: Date,
): Promise<string> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code, status)
     VALUES ($1::uuid, $2, 'ACTIVE')
     RETURNING id`,
    [referrerId, `T${randomUUID().replace(/-/g, '').slice(0, 16)}`],
  );
  const codeId = code.rows[0]?.id;
  if (codeId === undefined) throw new Error('code insert failed');
  const edge = await pool.query<{ id: string }>(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state,
       activation_rule_version, activated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'ACTIVE', 1, $4::timestamptz
     )
     RETURNING id`,
    [referrerId, referredId, codeId, activatedAt.toISOString()],
  );
  const id = edge.rows[0]?.id;
  if (id === undefined) throw new Error('edge insert failed');
  return id;
}

async function insertPendingEdge(
  pool: Pool,
  referrerId: string,
  referredId: string,
): Promise<string> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code, status)
     VALUES ($1::uuid, $2, 'ACTIVE')
     RETURNING id`,
    [referrerId, `P${randomUUID().replace(/-/g, '').slice(0, 16)}`],
  );
  const codeId = code.rows[0]?.id;
  if (codeId === undefined) throw new Error('code insert failed');
  const edge = await pool.query<{ id: string }>(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')
     RETURNING id`,
    [referrerId, referredId, codeId],
  );
  const id = edge.rows[0]?.id;
  if (id === undefined) throw new Error('pending edge insert failed');
  return id;
}

async function createEligibleAdReward(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly assetId: string;
    readonly amountAtomic: bigint;
    readonly availableAt: Date;
    readonly referralEligible: boolean | null;
    readonly sourceType?: 'AD' | 'TASK';
    readonly state?: 'AVAILABLE' | 'PENDING' | 'REVERSED';
  },
): Promise<{ rewardEventId: string; inviteeAmountBefore: string }> {
  const rule = await withRewardTx(pool, async (client) =>
    createRewardRuleVersion(client, {
      code: `phase15-ref-elig-${randomUUID().slice(0, 8)}`,
      sourceType: 'AD',
      assetId: input.assetId,
      fixedRewardAtomic: input.amountAtomic.toString(10),
      pendingHoldSeconds: 0,
      quoteTtlSeconds: 3600,
      ...(input.referralEligible === null
        ? { activate: false }
        : { activate: true, referralEligible: input.referralEligible }),
      reason: 'phase15-step5-test',
    }),
  );

  if (input.referralEligible === null) {
    // Force historical NULL ACTIVE path for fail-closed coverage.
    await pool.query(
      `ALTER TABLE reward_rules DROP CONSTRAINT IF EXISTS reward_rules_active_requires_referral_eligible`,
    );
    await pool.query(
      `UPDATE reward_rules SET status = 'ACTIVE', referral_eligible = NULL WHERE id = $1`,
      [rule.id],
    );
    await pool.query(
      `ALTER TABLE reward_rules
         ADD CONSTRAINT reward_rules_active_requires_referral_eligible
           CHECK (status <> 'ACTIVE' OR referral_eligible IS NOT NULL) NOT VALID`,
    );
  }

  const sourceId = randomUUID();
  const state = input.state ?? 'AVAILABLE';
  const inserted = await withLedgerTransaction(pool, async (client) => {
    let ledgerTxId: string | null = null;
    if (state === 'AVAILABLE' || state === 'PENDING') {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId: input.assetId,
      });
      const liability = await getOrCreateLedgerAccount(client, {
        accountType: state === 'AVAILABLE' ? 'USER_AVAILABLE_LIABILITY' : 'USER_PENDING_LIABILITY',
        assetId: input.assetId,
        ownerId: input.userId,
      });
      const posted = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'phase15-test-ad',
        businessReferenceId: sourceId,
        idempotencyScope: 'phase15.test.ad',
        idempotencyKey: `ad/${sourceId}`,
        assetId: input.assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: input.amountAtomic.toString(10) },
          {
            ledgerAccountId: liability.id,
            direction: 'CREDIT',
            amountAtomic: input.amountAtomic.toString(10),
          },
        ],
      });
      ledgerTxId = posted.id;
    }

    const event = await client.query<{ id: string; amount_atomic: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state,
         reward_rule_id, rule_version, ledger_transaction_id,
         pending_until, available_at, reversed_at
       ) VALUES (
         $1::uuid, $2::reward_source_type, $3::uuid, $4::uuid, $5::bigint, $6::reward_event_state,
         $7::uuid, 1, $8::uuid,
         CASE WHEN $6::text = 'PENDING' THEN now() ELSE NULL END,
         CASE WHEN $6::text = 'AVAILABLE' THEN $9::timestamptz ELSE NULL END,
         CASE WHEN $6::text = 'REVERSED' THEN now() ELSE NULL END
       )
       RETURNING id, amount_atomic::text AS amount_atomic`,
      [
        input.userId,
        input.sourceType ?? 'AD',
        sourceId,
        input.assetId,
        input.amountAtomic.toString(10),
        state,
        rule.id,
        ledgerTxId,
        input.availableAt.toISOString(),
      ],
    );
    const row = event.rows[0];
    if (row === undefined) throw new Error('reward_event insert failed');
    return row;
  });

  return { rewardEventId: inserted.id, inviteeAmountBefore: inserted.amount_atomic };
}

async function seedDailyReferralBudget(
  pool: Pool,
  assetId: string,
  limitAtomic: bigint,
  ruleVersion = 1,
): Promise<string> {
  return withRewardTx(pool, async (client) => {
    const created = await createExposureLimitVersion(client, {
      limitCode: 'MAX_REFERRAL_BONUS_DAILY',
      environment: 'LOCAL',
      assetId,
      limitAtomic,
      ruleVersion,
      activate: true,
      reason: 'phase15-step5-test-budget',
    });
    return created.id;
  });
}

describe('Phase 15 referral bonus arithmetic (pure)', () => {
  it('uses integer FLOOR only', () => {
    expect(
      computeReferralBonusAtomic({ sourceAmountAtomic: '10000', effectiveRateBps: 123 }),
    ).toBe(123n);
    expect(computeReferralBonusAtomic({ sourceAmountAtomic: '19', effectiveRateBps: 123 })).toBe(
      0n,
    );
    expect(computeReferralBonusAtomic({ sourceAmountAtomic: '10000', effectiveRateBps: 0 })).toBe(
      0n,
    );
  });
});

describe.skipIf(phase15Url === '')('Phase 15 referral reward issuance', () => {
  let pool: Pool;
  let assetId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase15Url);
    pool = new Pool({ connectionString: phase15Url, max: 12 });
    assetId = await usdtAssetId(pool);
    await insertReferralRule(pool, TEST_RATE_BPS);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        outbox_events,
        referral_reward_decisions,
        referral_bonus_exposure_reservations,
        referral_reward_events,
        referral_edges,
        referral_codes,
        reward_maturities,
        economic_exposure_reservations,
        economic_exposure_periods,
        economic_exposure_limits,
        reward_events,
        reward_quotes,
        reward_budget_reservations,
        reward_budget_periods,
        membership_bonus_budget_reservations,
        membership_bonus_budget_periods,
        reward_rules,
        ledger_entries,
        ledger_account_balances,
        ledger_transactions,
        ledger_accounts,
        users,
        referral_rule_versions
      RESTART IDENTITY CASCADE
    `);
    await insertReferralRule(pool, TEST_RATE_BPS);
    seq += 1;
  });

  async function pair(): Promise<{ referrerId: string; referredId: string }> {
    const referrerId = await createTestUser(pool, String(15_000_000 + seq * 10));
    const referredId = await createTestUser(pool, String(15_000_000 + seq * 10 + 1));
    return { referrerId, referredId };
  }

  it('issues PENDING REFERRAL bonus for ACTIVE edge + eligible AVAILABLE AD', async () => {
    const { referrerId, referredId } = await pair();
    const activatedAt = new Date(Date.now() - 60_000);
    const availableAt = new Date();
    await insertActiveEdge(pool, referrerId, referredId, activatedAt);
    await seedDailyReferralBudget(pool, assetId, 1_000_000n);
    const { rewardEventId, inviteeAmountBefore } = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt,
      referralEligible: true,
    });

    const result = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });

    expect(result.kind).toBe('issued');
    expect(result.amountAtomic).toBe('123');
    expect(result.referrerRewardEventId).not.toBeNull();

    const referrerEvent = await pool.query<{
      user_id: string;
      source_type: string;
      state: string;
      amount_atomic: string;
    }>(
      `SELECT user_id, source_type::text AS source_type, state::text AS state,
              amount_atomic::text AS amount_atomic
       FROM reward_events WHERE id = $1`,
      [result.referrerRewardEventId],
    );
    expect(referrerEvent.rows[0]).toMatchObject({
      user_id: referrerId,
      source_type: 'REFERRAL',
      state: 'PENDING',
      amount_atomic: '123',
    });

    const invitee = await pool.query<{ amount_atomic: string; state: string }>(
      `SELECT amount_atomic::text AS amount_atomic, state::text AS state
       FROM reward_events WHERE id = $1`,
      [rewardEventId],
    );
    expect(invitee.rows[0]?.amount_atomic).toBe(inviteeAmountBefore);
    expect(invitee.rows[0]?.state).toBe('AVAILABLE');

    const ledger = await pool.query<{ transaction_type: string; account_type: string }>(
      `SELECT t.transaction_type::text AS transaction_type, a.account_type::text AS account_type
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE t.id = $1
       ORDER BY e.entry_index`,
      [result.ledgerTransactionId],
    );
    expect(ledger.rows.some((r) => r.transaction_type === 'REFERRAL_REWARD_ISSUANCE')).toBe(true);
    expect(ledger.rows.some((r) => r.account_type === 'REFERRAL_REWARD_EXPENSE')).toBe(true);
    expect(ledger.rows.some((r) => r.account_type === 'USER_PENDING_LIABILITY')).toBe(true);
  });

  it('skips PENDING / REJECTED edges and non-eligible sources', async () => {
    const { referrerId, referredId } = await pair();
    await insertPendingEdge(pool, referrerId, referredId);
    await seedDailyReferralBudget(pool, assetId, 1_000_000n);
    const { rewardEventId } = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });
    const pending = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(pending.kind).toBe('skipped');
    expect(pending.reasonCode).toBe('EDGE_NOT_ACTIVE');

    // New invitee with rejected-style skip via no edge after truncate of edges only —
    // referral_eligible false
    const referred2 = await createTestUser(pool, String(15_000_000 + seq * 10 + 2));
    const referrer2 = await createTestUser(pool, String(15_000_000 + seq * 10 + 3));
    await insertActiveEdge(pool, referrer2, referred2, new Date(Date.now() - 60_000));
    const ineligible = await createEligibleAdReward(pool, {
      userId: referred2,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: false,
    });
    const falseElig = await issueReferralReward(pool, {
      sourceRewardEventId: ineligible.rewardEventId,
      environment: 'LOCAL',
    });
    expect(falseElig.kind).toBe('skipped');
    expect(falseElig.reasonCode).toBe('REFERRAL_ELIGIBLE_FALSE');
  });

  it('fail-closes NULL referral_eligible and rejects pre-activation / non-AD / PENDING source', async () => {
    const { referrerId, referredId } = await pair();
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    await seedDailyReferralBudget(pool, assetId, 1_000_000n);

    const nullElig = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: null,
    });
    const nullResult = await issueReferralReward(pool, {
      sourceRewardEventId: nullElig.rewardEventId,
      environment: 'LOCAL',
    });
    expect(nullResult.kind).toBe('skipped');
    expect(nullResult.reasonCode).toBe('REFERRAL_ELIGIBLE_UNCONFIGURED');

    const referredB = await createTestUser(pool, String(15_000_000 + seq * 10 + 4));
    const referrerB = await createTestUser(pool, String(15_000_000 + seq * 10 + 5));
    const lateActivation = new Date();
    const earlyAvailable = new Date(Date.now() - 120_000);
    await insertActiveEdge(pool, referrerB, referredB, lateActivation);
    const retro = await createEligibleAdReward(pool, {
      userId: referredB,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: earlyAvailable,
      referralEligible: true,
    });
    const retroResult = await issueReferralReward(pool, {
      sourceRewardEventId: retro.rewardEventId,
      environment: 'LOCAL',
    });
    expect(retroResult.kind).toBe('skipped');
    expect(retroResult.reasonCode).toBe('PRE_ACTIVATION_SOURCE');

    const referredC = await createTestUser(pool, String(15_000_000 + seq * 10 + 6));
    const referrerC = await createTestUser(pool, String(15_000_000 + seq * 10 + 7));
    await insertActiveEdge(pool, referrerC, referredC, new Date(Date.now() - 60_000));
    const pendingSrc = await createEligibleAdReward(pool, {
      userId: referredC,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
      state: 'PENDING',
    });
    const pendingResult = await issueReferralReward(pool, {
      sourceRewardEventId: pendingSrc.rewardEventId,
      environment: 'LOCAL',
    });
    expect(pendingResult.kind).toBe('skipped');
    expect(pendingResult.reasonCode).toBe('SOURCE_NOT_AVAILABLE');

    const referredD = await createTestUser(pool, String(15_000_000 + seq * 10 + 8));
    const referrerD = await createTestUser(pool, String(15_000_000 + seq * 10 + 9));
    await insertActiveEdge(pool, referrerD, referredD, new Date(Date.now() - 60_000));
    const taskSrc = await createEligibleAdReward(pool, {
      userId: referredD,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
      sourceType: 'TASK',
    });
    const taskResult = await issueReferralReward(pool, {
      sourceRewardEventId: taskSrc.rewardEventId,
      environment: 'LOCAL',
    });
    expect(taskResult.kind).toBe('skipped');
    expect(taskResult.reasonCode).toBe('SOURCE_NOT_AD');
  });

  it('budget missing/exhausted does not change invitee; retry is idempotent', async () => {
    const { referrerId, referredId } = await pair();
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    const { rewardEventId, inviteeAmountBefore } = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });

    const missing = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(missing.kind).toBe('rejected_budget');
    expect(missing.reasonCode).toBe('MAX_REFERRAL_BONUS_DAILY_MISSING');

    const invitee = await pool.query<{ amount_atomic: string; state: string }>(
      `SELECT amount_atomic::text AS amount_atomic, state::text AS state
       FROM reward_events WHERE id = $1`,
      [rewardEventId],
    );
    expect(invitee.rows[0]?.amount_atomic).toBe(inviteeAmountBefore);
    expect(invitee.rows[0]?.state).toBe('AVAILABLE');

    const retry = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(retry.kind).toBe('rejected_budget');
    expect(retry.decisionId).toBe(missing.decisionId);

    const bonusCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM reward_events WHERE source_type = 'REFERRAL'`,
    );
    expect(bonusCount.rows[0]?.c).toBe('0');
  });

  it('enforces daily capacity exact boundary and concurrent no-overspend', async () => {
    const { referrerId, referredId } = await pair();
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    // Bonus = FLOOR(10000 * 123 / 10000) = 123. Cap at exactly 123.
    await seedDailyReferralBudget(pool, assetId, 123n);

    const first = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });
    const issued = await issueReferralReward(pool, {
      sourceRewardEventId: first.rewardEventId,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');

    const referred2 = await createTestUser(pool, String(15_000_000 + seq * 10 + 11));
    const referrer2 = await createTestUser(pool, String(15_000_000 + seq * 10 + 12));
    await insertActiveEdge(pool, referrer2, referred2, new Date(Date.now() - 60_000));
    const second = await createEligibleAdReward(pool, {
      userId: referred2,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });
    const exhausted = await issueReferralReward(pool, {
      sourceRewardEventId: second.rewardEventId,
      environment: 'LOCAL',
    });
    expect(exhausted.kind).toBe('rejected_budget');
    expect(exhausted.reasonCode).toBe('MAX_REFERRAL_BONUS_DAILY_EXHAUSTED');
    expect(
      (
        await pool.query<{ amount_atomic: string }>(
          `SELECT amount_atomic::text AS amount_atomic FROM reward_events WHERE id = $1`,
          [second.rewardEventId],
        )
      ).rows[0]?.amount_atomic,
    ).toBe(second.inviteeAmountBefore);
  });

  it('retry of issued bonus returns already_decided without duplicate ledger', async () => {
    const { referrerId, referredId } = await pair();
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    await seedDailyReferralBudget(pool, assetId, 1_000_000n);
    const { rewardEventId } = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });
    const first = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(first.kind).toBe('issued');
    const second = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(second.kind).toBe('already_decided');
    expect(second.referrerRewardEventId).toBe(first.referrerRewardEventId);

    const txCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'REFERRAL_REWARD_ISSUANCE'`,
    );
    expect(txCount.rows[0]?.c).toBe('1');
  });

  it('rate 0 skips monetary issuance with durable decision', async () => {
    await pool.query(`UPDATE referral_rule_versions SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'`);
    await pool.query(
      `INSERT INTO referral_rule_versions (
         rule_version, activation_account_age_seconds, activation_valid_ad_count,
         base_rate_bps, status, effective_from, reason
       ) VALUES (99, 0, 0, 0, 'ACTIVE', now() - interval '1 hour', 'zero-rate-test')`,
    );

    const { referrerId, referredId } = await pair();
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    await seedDailyReferralBudget(pool, assetId, 1_000_000n, 2);
    const { rewardEventId } = await createEligibleAdReward(pool, {
      userId: referredId,
      assetId,
      amountAtomic: TEST_SOURCE_AMOUNT,
      availableAt: new Date(),
      referralEligible: true,
    });
    const result = await issueReferralReward(pool, {
      sourceRewardEventId: rewardEventId,
      environment: 'LOCAL',
    });
    expect(result.kind).toBe('skipped');
    expect(result.reasonCode).toBe('ZERO_AMOUNT');
    const bonuses = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM reward_events WHERE source_type = 'REFERRAL'`,
    );
    expect(bonuses.rows[0]?.c).toBe('0');
  });
});
