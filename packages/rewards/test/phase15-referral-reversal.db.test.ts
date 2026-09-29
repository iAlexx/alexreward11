/**
 * Phase 15 Step 6 — referral-safe reward reversal + maturity guards.
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
  createExposureLimitVersion,
  createRewardRuleVersion,
  issueReferralReward,
  matureRewardEvent,
  reverseRewardEvent,
  RewardDomainError,
  withLedgerTransaction as withRewardTx,
} from '../src/index.js';
import { reverseRewardEventOnClient } from '../src/reverse-reward.js';
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

async function seedReferralRule(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO referral_rule_versions (
       rule_version, activation_account_age_seconds, activation_valid_ad_count,
       base_rate_bps, status, effective_from, reason
     ) VALUES (1, 0, 0, $1, 'ACTIVE', now() - interval '1 hour', 'phase15-step6-test')`,
    [TEST_RATE_BPS],
  );
}

async function insertActiveEdge(
  pool: Pool,
  referrerId: string,
  referredId: string,
  activatedAt: Date,
): Promise<string> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code, status)
     VALUES ($1::uuid, $2, 'ACTIVE') RETURNING id`,
    [referrerId, `C${randomUUID().replace(/-/g, '').slice(0, 16)}`],
  );
  const codeId = code.rows[0]?.id;
  if (codeId === undefined) throw new Error('code insert failed');
  const edge = await pool.query<{ id: string }>(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state,
       activation_rule_version, activated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', 1, $4::timestamptz)
     RETURNING id`,
    [referrerId, referredId, codeId, activatedAt.toISOString()],
  );
  const id = edge.rows[0]?.id;
  if (id === undefined) throw new Error('edge insert failed');
  return id;
}

async function createAvailableAd(
  pool: Pool,
  userId: string,
  assetId: string,
): Promise<string> {
  const rule = await withRewardTx(pool, async (client) =>
    createRewardRuleVersion(client, {
      code: `step6-${randomUUID().slice(0, 8)}`,
      sourceType: 'AD',
      assetId,
      fixedRewardAtomic: TEST_SOURCE_AMOUNT.toString(10),
      pendingHoldSeconds: 0,
      quoteTtlSeconds: 3600,
      referralEligible: true,
      activate: true,
      reason: 'phase15-step6',
    }),
  );
  const sourceId = randomUUID();
  return withLedgerTransaction(pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId,
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId,
      ownerId: userId,
    });
    const posted = await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase15-step6-ad',
      businessReferenceId: sourceId,
      idempotencyScope: 'phase15.step6.ad',
      idempotencyKey: `ad/${sourceId}`,
      assetId,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: TEST_SOURCE_AMOUNT.toString(10),
        },
        {
          ledgerAccountId: available.id,
          direction: 'CREDIT',
          amountAtomic: TEST_SOURCE_AMOUNT.toString(10),
        },
      ],
    });
    const event = await client.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, asset_id, amount_atomic, state,
         reward_rule_id, rule_version, ledger_transaction_id, available_at
       ) VALUES (
         $1::uuid, 'AD', $2::uuid, $3::uuid, $4::bigint, 'AVAILABLE',
         $5::uuid, 1, $6::uuid, now()
       ) RETURNING id`,
      [userId, sourceId, assetId, TEST_SOURCE_AMOUNT.toString(10), rule.id, posted.id],
    );
    const id = event.rows[0]?.id;
    if (id === undefined) throw new Error('ad insert failed');
    return id;
  });
}

describe.skipIf(phase15Url === '')('Phase 15 referral-safe reward reversal', () => {
  let pool: Pool;
  let assetId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase15Url);
    pool = new Pool({ connectionString: phase15Url, max: 10 });
    assetId = await usdtAssetId(pool);
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
        reward_rules,
        ledger_entries,
        ledger_account_balances,
        ledger_transactions,
        ledger_accounts,
        users,
        referral_rule_versions
      RESTART IDENTITY CASCADE
    `);
    await seedReferralRule(pool);
    await withRewardTx(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_REFERRAL_BONUS_DAILY',
        environment: 'LOCAL',
        assetId,
        limitAtomic: 1_000_000n,
        ruleVersion: 1,
        activate: true,
        reason: 'step6-budget',
      });
    });
    seq += 1;
  });

  it('reverses PENDING source and cascades to PENDING referral bonus', async () => {
    const referrerId = await createTestUser(pool, String(16_000_000 + seq * 10));
    const referredId = await createTestUser(pool, String(16_000_000 + seq * 10 + 1));
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    const sourceId = await createAvailableAd(pool, referredId, assetId);

    const issued = await issueReferralReward(pool, {
      sourceRewardEventId: sourceId,
      environment: 'LOCAL',
    });
    expect(issued.kind).toBe('issued');
    expect(issued.referrerRewardEventId).not.toBeNull();

    const originalIssuance = await pool.query<{ id: string }>(
      `SELECT ledger_transaction_id AS id FROM reward_events WHERE id = $1`,
      [sourceId],
    );
    const originalTx = originalIssuance.rows[0]?.id;

    const reversed = await reverseRewardEvent(pool, {
      rewardEventId: sourceId,
      reason: 'test-origin-reversal',
    });
    expect(reversed.state).toBe('REVERSED');
    expect(reversed.cascadedReferralRewardEventIds).toContain(issued.referrerRewardEventId);

    const source = await pool.query<{ state: string; reversal_ledger_transaction_id: string }>(
      `SELECT state::text AS state, reversal_ledger_transaction_id
       FROM reward_events WHERE id = $1`,
      [sourceId],
    );
    expect(source.rows[0]?.state).toBe('REVERSED');
    expect(source.rows[0]?.reversal_ledger_transaction_id).not.toBeNull();
    expect(source.rows[0]?.reversal_ledger_transaction_id).not.toBe(originalTx);

    const referral = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [issued.referrerRewardEventId],
    );
    expect(referral.rows[0]?.state).toBe('REVERSED');

    // Historical issuance transaction untouched.
    const hist = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions WHERE id = $1`,
      [originalTx],
    );
    expect(hist.rows[0]?.c).toBe('1');

    const retry = await reverseRewardEvent(pool, {
      rewardEventId: sourceId,
      reason: 'test-origin-reversal-retry',
    });
    expect(retry.created).toBe(false);
    expect(retry.reversalLedgerTransactionId).toBe(source.rows[0]?.reversal_ledger_transaction_id);
  });

  it('blocks referral maturity after origin is reversed', async () => {
    const referrerId = await createTestUser(pool, String(16_000_000 + seq * 10 + 2));
    const referredId = await createTestUser(pool, String(16_000_000 + seq * 10 + 3));
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 60_000));
    const sourceId = await createAvailableAd(pool, referredId, assetId);
    const issued = await issueReferralReward(pool, {
      sourceRewardEventId: sourceId,
      environment: 'LOCAL',
    });
    expect(issued.referrerRewardEventId).not.toBeNull();

    // Internal non-cascade reverse of origin only — leave referral PENDING to prove maturity guard.
    await withLedgerTransaction(pool, (client) =>
      reverseRewardEventOnClient(
        client,
        { rewardEventId: sourceId, reason: 'block-maturity' },
        { cascadeReferral: false },
      ),
    );
    const referralState = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [issued.referrerRewardEventId],
    );
    expect(referralState.rows[0]?.state).toBe('PENDING');

    await expect(
      matureRewardEvent(pool, { rewardEventId: issued.referrerRewardEventId! }),
    ).rejects.toMatchObject({
      code: 'MATURITY_INVALID_STATE',
    } satisfies Partial<RewardDomainError>);
  });

  it('reverses source without referral as no-op cascade', async () => {
    const userId = await createTestUser(pool, String(16_000_000 + seq * 10 + 4));
    const sourceId = await createAvailableAd(pool, userId, assetId);
    const reversed = await reverseRewardEvent(pool, {
      rewardEventId: sourceId,
      reason: 'no-referral',
    });
    expect(reversed.state).toBe('REVERSED');
    expect(reversed.cascadedReferralRewardEventIds).toEqual([]);
  });

  it('does not mutate original ledger rows on reversal', async () => {
    const userId = await createTestUser(pool, String(16_000_000 + seq * 10 + 5));
    const sourceId = await createAvailableAd(pool, userId, assetId);
    const before = await pool.query<{
      id: string;
      transaction_type: string;
      entry_count: string;
    }>(
      `SELECT t.id, t.transaction_type::text AS transaction_type, count(e.*)::text AS entry_count
       FROM reward_events r
       JOIN ledger_transactions t ON t.id = r.ledger_transaction_id
       JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       WHERE r.id = $1
       GROUP BY t.id, t.transaction_type`,
      [sourceId],
    );
    const originalId = before.rows[0]?.id;
    const originalCount = before.rows[0]?.entry_count;

    await reverseRewardEvent(pool, { rewardEventId: sourceId, reason: 'immutability' });

    const after = await pool.query<{
      transaction_type: string;
      entry_count: string;
      reverses: string | null;
    }>(
      `SELECT t.transaction_type::text AS transaction_type, count(e.*)::text AS entry_count,
              t.reverses_transaction_id::text AS reverses
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       WHERE t.id = $1
       GROUP BY t.id, t.transaction_type, t.reverses_transaction_id`,
      [originalId],
    );
    expect(after.rows[0]?.entry_count).toBe(originalCount);
    expect(after.rows[0]?.reverses).toBeNull();

    const linked = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE reverses_transaction_id = $1 AND transaction_type = 'REWARD_REVERSAL'`,
      [originalId],
    );
    expect(linked.rows[0]?.c).toBe('1');
  });
});
