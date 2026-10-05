/**
 * Phase 15 remediation — issuance redrive + maturity batch + transient retry.
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
  processDueReferralMaturityBatch,
  processReferralIssuanceBatch,
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

async function insertReferralRule(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO referral_rule_versions (
       rule_version, activation_account_age_seconds, activation_valid_ad_count,
       base_rate_bps, status, effective_from, reason
     ) VALUES (
       1, 0, 0, $1, 'ACTIVE', now() - interval '1 hour', 'phase15-maintenance-test'
     )`,
    [TEST_RATE_BPS],
  );
}

async function insertActiveEdge(
  pool: Pool,
  referrerId: string,
  referredId: string,
  activatedAt: Date,
): Promise<void> {
  const code = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code, status)
     VALUES ($1::uuid, $2, 'ACTIVE')
     RETURNING id`,
    [referrerId, `M${randomUUID().replace(/-/g, '').slice(0, 16)}`],
  );
  await pool.query(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state,
       activation_rule_version, activated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'ACTIVE', 1, $4::timestamptz
     )`,
    [referrerId, referredId, code.rows[0]!.id, activatedAt.toISOString()],
  );
}

async function seedDailyReferralBudget(pool: Pool, assetId: string): Promise<void> {
  await withRewardTx(pool, async (client) => {
    await createExposureLimitVersion(client, {
      limitCode: 'MAX_REFERRAL_BONUS_DAILY',
      environment: 'LOCAL',
      ruleVersion: 1,
      limitAtomic: '1000000',
      assetId,
      activate: true,
      reason: 'phase15-maintenance-test',
    });
  });
}

async function createEligibleAd(
  pool: Pool,
  userId: string,
  assetId: string,
  availableAt: Date,
): Promise<string> {
  const rule = await withRewardTx(pool, async (client) =>
    createRewardRuleVersion(client, {
      code: `phase15-maint-${randomUUID().slice(0, 8)}`,
      sourceType: 'AD',
      assetId,
      fixedRewardAtomic: TEST_SOURCE_AMOUNT.toString(10),
      pendingHoldSeconds: 0,
      quoteTtlSeconds: 3600,
      activate: true,
      referralEligible: true,
      reason: 'phase15-maintenance-test',
    }),
  );
  const sourceId = randomUUID();
  const inserted = await withLedgerTransaction(pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId,
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId,
      ownerId: userId,
    });
    const ledger = await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase15-maintenance-ad',
      businessReferenceId: sourceId,
      idempotencyScope: 'phase15.maintenance.ad',
      idempotencyKey: `ad/${sourceId}`,
      assetId,
      entries: [
        { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: TEST_SOURCE_AMOUNT.toString(10) },
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
         reward_rule_id, ledger_transaction_id, available_at
       ) VALUES (
         $1::uuid, 'AD', $2::uuid, $3::uuid, $4::bigint, 'AVAILABLE',
         $5::uuid, $6::uuid, $7::timestamptz
       )
       RETURNING id`,
      [
        userId,
        sourceId,
        assetId,
        TEST_SOURCE_AMOUNT.toString(10),
        rule.id,
        ledger.id,
        availableAt.toISOString(),
      ],
    );
    return event.rows[0]!.id;
  });
  return inserted;
}

describe.skipIf(phase15Url === '')('Phase 15 referral issuance/maturity batches', () => {
  let pool: Pool;
  let assetId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase15Url);
    pool = new Pool({ connectionString: phase15Url });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    seq += 1;
    await pool.query(`
      TRUNCATE TABLE
        outbox_events, reward_maturities, referral_bonus_exposure_reservations,
        referral_reward_decisions, referral_reward_events, referral_edges, referral_codes,
        referral_rule_versions, economic_exposure_periods, economic_exposure_limits,
        reward_events, reward_rules, ledger_entries, ledger_transactions, ledger_accounts,
        users
      RESTART IDENTITY CASCADE
    `);
    await insertReferralRule(pool);
    await seedDailyReferralBudget(pool, assetId);
  });

  it('issuance batch issues once; maturity batch matures REFERRAL; retry is idempotent', async () => {
    const referrerId = await createTestUser(pool, String(18_000_000 + seq * 10));
    const referredId = await createTestUser(pool, String(18_000_000 + seq * 10 + 1));
    const activatedAt = new Date(Date.now() - 120_000);
    await insertActiveEdge(pool, referrerId, referredId, activatedAt);
    const availableAt = new Date(Date.now() - 60_000);
    const sourceId = await createEligibleAd(pool, referredId, assetId, availableAt);

    const first = await processReferralIssuanceBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(first.scanned).toBe(1);
    expect(first.items[0]).toMatchObject({
      sourceRewardEventId: sourceId,
      ok: true,
      result: { kind: 'issued' },
    });

    const decisions = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM referral_reward_decisions WHERE source_reward_event_id = $1`,
      [sourceId],
    );
    expect(decisions.rows[0]?.c).toBe('1');

    const again = await processReferralIssuanceBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(again.scanned).toBe(0);

    await pool.query(
      `UPDATE reward_maturities SET scheduled_for = now() - interval '1 second'
       WHERE reward_event_id IN (
         SELECT referrer_reward_event_id FROM referral_reward_events WHERE source_reward_event_id = $1
       )`,
      [sourceId],
    );
    await pool.query(
      `UPDATE reward_events SET pending_until = now() - interval '1 second'
       WHERE id IN (
         SELECT referrer_reward_event_id FROM referral_reward_events WHERE source_reward_event_id = $1
       )`,
      [sourceId],
    );

    const matured = await processDueReferralMaturityBatch(pool, { limit: 10 });
    expect(matured.scanned).toBe(1);
    expect(matured.items[0]?.ok).toBe(true);

    const maturedAgain = await processDueReferralMaturityBatch(pool, { limit: 10 });
    expect(maturedAgain.scanned).toBe(0);
  });

  it('transient failure before decision is retriable once', async () => {
    const referrerId = await createTestUser(pool, String(18_100_000 + seq * 10));
    const referredId = await createTestUser(pool, String(18_100_000 + seq * 10 + 1));
    await insertActiveEdge(pool, referrerId, referredId, new Date(Date.now() - 120_000));
    const sourceId = await createEligibleAd(pool, referredId, assetId, new Date(Date.now() - 60_000));

    let calls = 0;
    const failed = await processReferralIssuanceBatch(
      pool,
      { environment: 'LOCAL', limit: 10 },
      {
        issueReferralReward: async (...args) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('injected-transient');
          }
          return issueReferralReward(...args);
        },
      },
    );
    expect(failed.items[0]).toMatchObject({
      sourceRewardEventId: sourceId,
      ok: false,
      retriable: true,
    });
    const mid = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM referral_reward_decisions WHERE source_reward_event_id = $1`,
      [sourceId],
    );
    expect(mid.rows[0]?.c).toBe('0');

    const retried = await processReferralIssuanceBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(retried.items[0]).toMatchObject({
      sourceRewardEventId: sourceId,
      ok: true,
      result: { kind: 'issued' },
    });
  });
});
