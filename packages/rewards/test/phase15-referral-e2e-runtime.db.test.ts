/**
 * Phase 15 MEGA remediation — isolated E2E runtime pipeline.
 * PENDING → age batch PENDING → age advance → ACTIVE → eligible AD →
 * issuance PENDING REFERRAL → maturity AVAILABLE → retry batches no duplicates.
 */
import { randomUUID } from 'node:crypto';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import { processPendingReferralActivationBatch } from '@alex-rewards/referrals';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createExposureLimitVersion,
  createRewardRuleVersion,
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

describe.skipIf(phase15Url === '')('Phase 15 E2E referral runtime pipeline', () => {
  let pool: Pool;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase15Url);
    pool = new Pool({ connectionString: phase15Url });
    assetId = await usdtAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('runs PENDING→ACTIVE→issuance→maturity without duplicate decisions', async () => {
    await pool.query(`
      TRUNCATE TABLE
        outbox_events, reward_maturities, referral_bonus_exposure_reservations,
        referral_reward_decisions, referral_reward_events, referral_edges, referral_codes,
        referral_rule_versions, economic_exposure_periods, economic_exposure_limits,
        reward_events, reward_rules, ledger_entries, ledger_transactions, ledger_accounts,
        users
      RESTART IDENTITY CASCADE
    `);

    await pool.query(
      `INSERT INTO referral_rule_versions (
         rule_version, activation_account_age_seconds, activation_valid_ad_count,
         base_rate_bps, status, effective_from, reason
       ) VALUES (1, 86400, 0, 123, 'ACTIVE', now() - interval '1 hour', 'phase15-e2e')`,
    );

    await withRewardTx(pool, async (client) => {
      await createExposureLimitVersion(client, {
        limitCode: 'MAX_REFERRAL_BONUS_DAILY',
        environment: 'LOCAL',
        ruleVersion: 1,
        limitAtomic: '1000000',
        assetId,
        activate: true,
        reason: 'phase15-e2e',
      });
    });

    const referrerId = await createTestUser(pool, '19000001');
    const inviteeId = await createTestUser(pool, '19000002');
    // Override created_at to young account
    await pool.query(`UPDATE users SET created_at = now() - interval '1 hour' WHERE id = $1`, [
      inviteeId,
    ]);

    const code = await pool.query<{ id: string }>(
      `INSERT INTO referral_codes (user_id, code, status)
       VALUES ($1::uuid, 'E2EREFCODE0001', 'ACTIVE') RETURNING id`,
      [referrerId],
    );
    const edge = await pool.query<{ id: string }>(
      `INSERT INTO referral_edges (referrer_user_id, referred_user_id, code_id, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')
       RETURNING id`,
      [referrerId, inviteeId, code.rows[0]!.id],
    );
    const edgeId = edge.rows[0]!.id;

    const agePending = await processPendingReferralActivationBatch(pool, { limit: 10 });
    expect(agePending.items[0]).toMatchObject({
      edgeId,
      ok: true,
      outcome: { outcome: 'STILL_PENDING' },
    });

    await pool.query(`UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, [
      inviteeId,
    ]);

    const activated = await processPendingReferralActivationBatch(pool, { limit: 10 });
    expect(activated.items[0]).toMatchObject({
      edgeId,
      ok: true,
      outcome: { outcome: 'ACTIVATED' },
    });

    // Eligible AD created after activation (activated_at <= available_at)
    const rule = await withRewardTx(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `phase15-e2e-${randomUUID().slice(0, 8)}`,
        sourceType: 'AD',
        assetId,
        fixedRewardAtomic: '10000',
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 3600,
        activate: true,
        referralEligible: true,
        reason: 'phase15-e2e',
      }),
    );
    const sourceUuid = randomUUID();
    const adId = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const availableAcct = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: inviteeId,
      });
      const ledger = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'phase15-e2e-ad',
        businessReferenceId: sourceUuid,
        idempotencyScope: 'phase15.e2e.ad',
        idempotencyKey: `ad/${sourceUuid}`,
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '10000' },
          { ledgerAccountId: availableAcct.id, direction: 'CREDIT', amountAtomic: '10000' },
        ],
      });
      const event = await client.query<{ id: string }>(
        `INSERT INTO reward_events (
           user_id, source_type, source_id, asset_id, amount_atomic, state,
           reward_rule_id, ledger_transaction_id, available_at
         ) VALUES (
           $1::uuid, 'AD', $2::uuid, $3::uuid, 10000, 'AVAILABLE',
           $4::uuid, $5::uuid, now()
         ) RETURNING id`,
        [inviteeId, sourceUuid, assetId, rule.id, ledger.id],
      );
      return event.rows[0]!.id;
    });

    const issued = await processReferralIssuanceBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(issued.items[0]).toMatchObject({
      sourceRewardEventId: adId,
      ok: true,
      result: { kind: 'issued' },
    });

    const referralEvent = await pool.query<{ id: string; state: string }>(
      `SELECT re.id, re.state::text AS state
       FROM referral_reward_events rre
       JOIN reward_events re ON re.id = rre.referrer_reward_event_id
       WHERE rre.source_reward_event_id = $1`,
      [adId],
    );
    expect(referralEvent.rows[0]?.state).toBe('PENDING');

    await pool.query(
      `UPDATE reward_maturities SET scheduled_for = now() - interval '1 second'
       WHERE reward_event_id = $1`,
      [referralEvent.rows[0]!.id],
    );
    await pool.query(
      `UPDATE reward_events SET pending_until = now() - interval '1 second' WHERE id = $1`,
      [referralEvent.rows[0]!.id],
    );

    const matured = await processDueReferralMaturityBatch(pool, { limit: 10 });
    expect(matured.items[0]?.ok).toBe(true);

    const available = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM reward_events WHERE id = $1`,
      [referralEvent.rows[0]!.id],
    );
    expect(available.rows[0]?.state).toBe('AVAILABLE');

    const issuanceRetry = await processReferralIssuanceBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(issuanceRetry.scanned).toBe(0);
    const maturityRetry = await processDueReferralMaturityBatch(pool, { limit: 10 });
    expect(maturityRetry.scanned).toBe(0);

    const decisionCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM referral_reward_decisions WHERE source_reward_event_id = $1`,
      [adId],
    );
    expect(decisionCount.rows[0]?.c).toBe('1');

    const decision = await pool.query<{
      rate_source: string;
      referral_rule_version: number;
      user_membership_id: string | null;
      entitlement_rule_version_id: string | null;
    }>(
      `SELECT rate_source::text AS rate_source, referral_rule_version,
              user_membership_id, entitlement_rule_version_id
       FROM referral_reward_decisions WHERE source_reward_event_id = $1`,
      [adId],
    );
    expect(decision.rows[0]).toMatchObject({
      rate_source: 'BASE_RULE',
      referral_rule_version: 1,
      user_membership_id: null,
      entitlement_rule_version_id: null,
    });
  }, 120_000);
});
