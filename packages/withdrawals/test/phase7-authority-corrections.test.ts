/**
 * Phase 7 Owner correction gates: network-scoped asset, entitlement rule binding,
 * and reconcile without caller-controlled financial resolution.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceFakeReconciliation,
  createWithdrawalQuote,
  FakePayoutChain,
  localWithdrawalEngineFixtureConfig,
  resolvePlatformFeeDiscount,
  resolvePriorityReview,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
} from '../src/index.js';
import { applyObservationInTxn } from '../src/reconcile.js';
import {
  bindVerifiedPrimaryWallet,
  claimFounderForUser,
  createApprovedWithdrawal,
  createTestUser,
  engineConfig,
  fundHotWalletUsdt,
  fundUserAvailable,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedFounderFeeDiscount,
  seedFounderPriorityReview,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 authority corrections', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    await pool.query(
      `UPDATE assets a
       SET status = 'ACTIVE'
       FROM networks n
       WHERE a.network_id = n.id
         AND n.code = 'TON_TESTNET'
         AND a.symbol = 'USDT'`,
    );
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
    await fundHotWalletUsdt(pool, hotWalletId, '100000000');
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('network-scoped withdrawal asset', () => {
    it('TON_TESTNET + USDT resolves the exact testnet asset', async () => {
      const userId = await createTestUser(pool, '7601');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      await fundUserAvailable(pool, userId, '500000');
      const quote = await createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      });
      expect(quote.assetId).toBe(assetId);
      expect(quote.networkId).toBe(networkId);
    });

    it('two networks with USDT cannot cross-select', async () => {
      const altCode = `TON_ALT_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const alt = await pool.query<{ id: string }>(
        `INSERT INTO networks (
           code, chain, environment, display_name, global_chain_identifier, status
         ) VALUES (
           $1, 'TON', 'TESTNET', 'ALT TESTNET', $2, 'ACTIVE'
         )
         RETURNING id`,
        [altCode, `ton:alt-${altCode}`],
      );
      const altNetworkId = alt.rows[0]!.id;
      const altAsset = await pool.query<{ id: string }>(
        `INSERT INTO assets (
           network_id, symbol, name, decimals, is_native, contract_identity, status
         ) VALUES (
           $1::uuid, 'USDT', 'Alt USDT', 6, false, 'ALT-USDT-PLACEHOLDER', 'ACTIVE'
         )
         RETURNING id`,
        [altNetworkId],
      );
      const altAssetId = altAsset.rows[0]!.id;

      const userId = await createTestUser(pool, '7602');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      await fundUserAvailable(pool, userId, '500000');
      const quote = await createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      });
      expect(quote.assetId).toBe(assetId);
      expect(quote.assetId).not.toBe(altAssetId);
      expect(quote.networkId).toBe(networkId);
    });

    it('selected network with no matching USDT fails closed', async () => {
      const emptyCode = `TON_EMPTY_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await pool.query(
        `INSERT INTO networks (
           code, chain, environment, display_name, global_chain_identifier, status
         ) VALUES (
           $1, 'TON', 'TESTNET', 'EMPTY', $2, 'ACTIVE'
         )`,
        [emptyCode, `ton:empty-${emptyCode}`],
      );
      const userId = await createTestUser(pool, '7603');
      const emptyCfg = localWithdrawalEngineFixtureConfig({
        acceptedNetworkCode: emptyCode,
      });
      await expect(
        createWithdrawalQuote(pool, emptyCfg, {
          authenticatedUserId: userId,
          amountAtomic: '200000',
        }),
      ).rejects.toMatchObject({ code: 'CONFIG' });
    });

    it('disabled asset fails closed', async () => {
      await pool.query(`UPDATE assets SET status = 'DISABLED' WHERE id = $1::uuid`, [assetId]);
      try {
        const userId = await createTestUser(pool, '7604');
        await bindVerifiedPrimaryWallet(pool, userId, networkId);
        await expect(
          createWithdrawalQuote(pool, engineConfig, {
            authenticatedUserId: userId,
            amountAtomic: '200000',
          }),
        ).rejects.toMatchObject({ code: 'CONFIG' });
      } finally {
        await pool.query(`UPDATE assets SET status = 'ACTIVE' WHERE id = $1::uuid`, [assetId]);
      }
    });

    it('wallet network and quote asset/network remain coherent', async () => {
      const userId = await createTestUser(pool, '7605');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      await fundUserAvailable(pool, userId, '500000');
      const quote = await createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      });
      const wallet = await pool.query<{ network_id: string }>(
        `SELECT network_id FROM user_wallets WHERE id = $1::uuid`,
        [quote.primaryWalletId],
      );
      expect(wallet.rows[0]?.network_id).toBe(quote.networkId);
      expect(quote.networkId).toBe(networkId);
      expect(quote.assetId).toBe(assetId);
    });
  });

  describe('entitlement rule binding', () => {
    it('rejects fee entitlement pointing at reward-bonus BPS rule (DB + runtime)', async () => {
      const bonus = await pool.query<{ id: string }>(
        `SELECT id FROM entitlements WHERE code = 'ELIGIBLE_REWARD_BONUS'`,
      );
      const fee = await pool.query<{ id: string }>(
        `SELECT id FROM entitlements WHERE code = 'WITHDRAWAL_PLATFORM_FEE_DISCOUNT'`,
      );
      const plan = await pool.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
      );
      const bonusRule = await pool.query<{ id: string }>(
        `INSERT INTO membership_benefit_rule_versions (
           entitlement_id, membership_plan_id, rule_version, value_bps,
           status, effective_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 91, 2500,
           'ACTIVE', now(), 'cross-bind probe reward bonus'
         )
         RETURNING id`,
        [bonus.rows[0]!.id, plan.rows[0]!.id],
      );

      await expect(
        pool.query(
          `INSERT INTO membership_plan_entitlements (
             membership_plan_id, entitlement_id, rule_version_id, valid_from, status
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
          [plan.rows[0]!.id, fee.rows[0]!.id, bonusRule.rows[0]!.id],
        ),
      ).rejects.toThrow(/entitlement_id must match|check_violation/i);

      // Runtime JOIN fail-closed: corrupt mapping inserted with binding trigger disabled.
      const userId = await createTestUser(pool, '7610');
      await claimFounderForUser(pool, userId);
      await pool.query(
        `ALTER TABLE membership_plan_entitlements DISABLE TRIGGER membership_plan_entitlements_rule_binding`,
      );
      try {
        await pool.query(
          `INSERT INTO membership_plan_entitlements (
             membership_plan_id, entitlement_id, rule_version_id, valid_from, status
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
          [plan.rows[0]!.id, fee.rows[0]!.id, bonusRule.rows[0]!.id],
        );
      } finally {
        await pool.query(
          `ALTER TABLE membership_plan_entitlements ENABLE TRIGGER membership_plan_entitlements_rule_binding`,
        );
      }

      await withWithdrawalTransaction(pool, async (client) => {
        const resolved = await resolvePlatformFeeDiscount(client, {
          userId,
          assetId,
          asOf: new Date(),
        });
        expect(resolved).toBeNull();
      });
    });

    it('rejects fee entitlement pointing at another plan rule', async () => {
      const fee = await pool.query<{ id: string }>(
        `SELECT id FROM entitlements WHERE code = 'WITHDRAWAL_PLATFORM_FEE_DISCOUNT'`,
      );
      const founder = await pool.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
      );
      const standard = await pool.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
      );
      const otherPlanRule = await pool.query<{ id: string }>(
        `INSERT INTO membership_benefit_rule_versions (
           entitlement_id, membership_plan_id, rule_version, value_bps,
           status, effective_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 93, 1000,
           'ACTIVE', now(), 'standard-only fee rule'
         )
         RETURNING id`,
        [fee.rows[0]!.id, standard.rows[0]!.id],
      );

      await expect(
        pool.query(
          `INSERT INTO membership_plan_entitlements (
             membership_plan_id, entitlement_id, rule_version_id, valid_from, status
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
          [founder.rows[0]!.id, fee.rows[0]!.id, otherPlanRule.rows[0]!.id],
        ),
      ).rejects.toThrow(/another membership plan|check_violation/i);
    });

    it('correct fee rule applies', async () => {
      const userId = await createTestUser(pool, '7611');
      await claimFounderForUser(pool, userId);
      await withWithdrawalTransaction(pool, async (client) => {
        await seedFounderFeeDiscount(client, { discountBps: 5000, assetId });
        const resolved = await resolvePlatformFeeDiscount(client, {
          userId,
          assetId,
          asOf: new Date(),
        });
        expect(resolved?.discountBps).toBe(5000);
      });
    });

    it('rejects priority mapping pointing at unrelated BOOLEAN rule', async () => {
      const unrelated = await pool.query<{ id: string }>(
        `INSERT INTO entitlements (
           code, name, value_type, security_classification, description
         ) VALUES (
           'TEST_UNRELATED_BOOL_${randomUUID().slice(0, 8)}',
           'Unrelated bool',
           'BOOLEAN',
           'INTERNAL',
           'phase7 binding probe'
         )
         RETURNING id`,
      );
      const priority = await pool.query<{ id: string }>(
        `SELECT id FROM entitlements WHERE code = 'PRIORITY_WITHDRAWAL_REVIEW'`,
      );
      const plan = await pool.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
      );
      const unrelatedRule = await pool.query<{ id: string }>(
        `INSERT INTO membership_benefit_rule_versions (
           entitlement_id, membership_plan_id, rule_version, value_boolean,
           status, effective_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 94, true,
           'ACTIVE', now(), 'unrelated boolean rule'
         )
         RETURNING id`,
        [unrelated.rows[0]!.id, plan.rows[0]!.id],
      );

      await expect(
        pool.query(
          `INSERT INTO membership_plan_entitlements (
             membership_plan_id, entitlement_id, rule_version_id, valid_from, status
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
          [plan.rows[0]!.id, priority.rows[0]!.id, unrelatedRule.rows[0]!.id],
        ),
      ).rejects.toThrow(/entitlement_id must match|check_violation/i);

      const userId = await createTestUser(pool, '7612');
      await claimFounderForUser(pool, userId);
      await pool.query(
        `ALTER TABLE membership_plan_entitlements DISABLE TRIGGER membership_plan_entitlements_rule_binding`,
      );
      try {
        await pool.query(
          `INSERT INTO membership_plan_entitlements (
             membership_plan_id, entitlement_id, rule_version_id, valid_from, status
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
          [plan.rows[0]!.id, priority.rows[0]!.id, unrelatedRule.rows[0]!.id],
        );
      } finally {
        await pool.query(
          `ALTER TABLE membership_plan_entitlements ENABLE TRIGGER membership_plan_entitlements_rule_binding`,
        );
      }

      await withWithdrawalTransaction(pool, async (client) => {
        const resolved = await resolvePriorityReview(client, {
          userId,
          asOf: new Date(),
        });
        expect(resolved).toBeNull();
      });
    });

    it('correct priority rule applies', async () => {
      const userId = await createTestUser(pool, '7613');
      await claimFounderForUser(pool, userId);
      await withWithdrawalTransaction(pool, async (client) => {
        await seedFounderPriorityReview(client);
        const resolved = await resolvePriorityReview(client, {
          userId,
          asOf: new Date(),
        });
        expect(resolved?.enabled).toBe(true);
      });
    });

    it('ambiguous correct fee candidates still fail closed', async () => {
      const userId = await createTestUser(pool, '7614');
      await claimFounderForUser(pool, userId);
      const standard = await pool.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
      );
      await pool.query(
        `INSERT INTO user_memberships (
           user_id, membership_plan_id, status, source, claimed_at
         ) VALUES ($1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now())`,
        [userId, standard.rows[0]!.id],
      );
      await withWithdrawalTransaction(pool, async (client) => {
        await seedFounderFeeDiscount(client, {
          discountBps: 1000,
          assetId,
          ruleVersion: 1,
          planCode: 'FOUNDER_LIFETIME',
        });
        await seedFounderFeeDiscount(client, {
          discountBps: 2000,
          assetId,
          ruleVersion: 1,
          planCode: 'STANDARD',
        });
        await expect(
          resolvePlatformFeeDiscount(client, {
            userId,
            assetId,
            asOf: new Date(),
          }),
        ).rejects.toMatchObject({ code: 'ENTITLEMENT_AMBIGUOUS' });
      });
    });
  });

  describe('reconcile authority', () => {
    it('plain caller DEFINITIVE_NONPAYMENT observation cannot create definitive evidence', async () => {
      const userId = await createTestUser(pool, '7620');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });
      const unknown = await runFakePayoutPipeline(
        pool,
        engineConfig,
        withdrawalId,
        'BROADCAST_RESULT_UNKNOWN',
      );
      const attempt = await pool.query<{
        query_id: string;
        attempt_number: number;
        canonical_message_hash: string;
        net_amount_atomic: string;
        recipient: string;
      }>(
        `SELECT a.query_id::text, a.attempt_number, a.canonical_message_hash,
                wd.net_amount_atomic::text,
                COALESCE(w.friendly_address, w.raw_address) AS recipient
         FROM withdrawal_attempts a
         JOIN withdrawals wd ON wd.id = a.withdrawal_id
         JOIN user_wallets w ON w.id = wd.wallet_id
         WHERE a.id = $1::uuid`,
        [unknown.attemptId],
      );
      const row = attempt.rows[0]!;
      const reservedBefore = await userBucketBalance(
        pool,
        userId,
        assetId,
        'USER_RESERVED_LIABILITY',
      );

      // Field-perfect but unbranded plain object — not adapter provenance.
      const plain = {
        phase: 'DEFINITIVE_NONPAYMENT' as const,
        queryId: BigInt(row.query_id),
        recipientAddress: row.recipient,
        amountAtomic: row.net_amount_atomic,
        assetSymbol: 'USDT',
        correlationReference: `fake:${withdrawalId}:${row.attempt_number}`,
        mayHaveBroadcast: true,
        withdrawalId,
        attemptId: unknown.attemptId!,
        canonicalMessageHash: row.canonical_message_hash,
      };
      const result = await withWithdrawalTransaction(pool, async (client) =>
        applyObservationInTxn(client, engineConfig, {
          withdrawalId,
          attemptId: unknown.attemptId!,
          observation: plain,
        }),
      );
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.state).toBe('RECONCILE_REQUIRED');
      const evidence = await pool.query<{ resolution: string }>(
        `SELECT resolution::text FROM withdrawal_payout_reconciliations
         WHERE id = $1::uuid`,
        [result.reconciliationId],
      );
      expect(evidence.rows[0]?.resolution).toBe('AMBIGUOUS');
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        reservedBefore,
      );
    });

    it('plain caller CONFIRMED observation cannot settle by matching fields', async () => {
      const userId = await createTestUser(pool, '7621');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });
      const unknown = await runFakePayoutPipeline(
        pool,
        engineConfig,
        withdrawalId,
        'BROADCAST_RESULT_UNKNOWN',
      );
      const attempt = await pool.query<{
        query_id: string;
        attempt_number: number;
        canonical_message_hash: string;
        net_amount_atomic: string;
        recipient: string;
      }>(
        `SELECT a.query_id::text, a.attempt_number, a.canonical_message_hash,
                wd.net_amount_atomic::text,
                COALESCE(w.friendly_address, w.raw_address) AS recipient
         FROM withdrawal_attempts a
         JOIN withdrawals wd ON wd.id = a.withdrawal_id
         JOIN user_wallets w ON w.id = wd.wallet_id
         WHERE a.id = $1::uuid`,
        [unknown.attemptId],
      );
      const row = attempt.rows[0]!;
      const plain = {
        phase: 'CONFIRMED' as const,
        queryId: BigInt(row.query_id),
        recipientAddress: row.recipient,
        amountAtomic: row.net_amount_atomic,
        assetSymbol: 'USDT',
        correlationReference: `fake:${withdrawalId}:${row.attempt_number}`,
        mayHaveBroadcast: true,
        withdrawalId,
        attemptId: unknown.attemptId!,
        canonicalMessageHash: row.canonical_message_hash,
      };
      const result = await withWithdrawalTransaction(pool, async (client) =>
        applyObservationInTxn(client, engineConfig, {
          withdrawalId,
          attemptId: unknown.attemptId!,
          observation: plain,
        }),
      );
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.state).toBe('RECONCILE_REQUIRED');
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        200000n,
      );
    });

    it('fake authoritative confirmed observation settles', async () => {
      const userId = await createTestUser(pool, '7622');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });
      const confirmed = await runFakePayoutPipeline(
        pool,
        engineConfig,
        withdrawalId,
        'CONFIRMED_SUCCESS',
      );
      expect(confirmed.state).toBe('CONFIRMED');
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    });

    it('fake authoritative definitive non-payment permits safe recovery', async () => {
      const userId = await createTestUser(pool, '7623');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });
      const fakeChain = new FakePayoutChain(engineConfig);
      const unknown = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
        withdrawalId,
        scenario: 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT',
      });
      const held = await advanceFakeReconciliation(pool, engineConfig, fakeChain, {
        withdrawalId,
        attemptId: unknown.attemptId!,
        scenario: 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT',
      });
      expect(held.state).toBe('HELD');
      expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(
        200000n,
      );
    });

    it('mismatching plain observation remains ambiguous; Reserved untouched', async () => {
      const userId = await createTestUser(pool, '7624');
      await bindVerifiedPrimaryWallet(pool, userId, networkId);
      const withdrawalId = await createApprovedWithdrawal(pool, {
        userId,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
        amountAtomic: '200000',
      });
      const unknown = await runFakePayoutPipeline(
        pool,
        engineConfig,
        withdrawalId,
        'BROADCAST_RESULT_UNKNOWN',
      );
      const attempt = await pool.query<{
        query_id: string;
        net_amount_atomic: string;
      }>(
        `SELECT a.query_id::text AS query_id,
                wd.net_amount_atomic::text AS net_amount_atomic
         FROM withdrawal_attempts a
         JOIN withdrawals wd ON wd.id = a.withdrawal_id
         WHERE a.id = $1::uuid`,
        [unknown.attemptId],
      );
      const reservedBefore = await userBucketBalance(
        pool,
        userId,
        assetId,
        'USER_RESERVED_LIABILITY',
      );

      const result = await withWithdrawalTransaction(pool, async (client) =>
        applyObservationInTxn(client, engineConfig, {
          withdrawalId,
          attemptId: unknown.attemptId!,
          observation: {
            phase: 'CONFIRMED',
            queryId: BigInt(attempt.rows[0]!.query_id),
            recipientAddress: 'EQ_WRONG_' + randomUUID().slice(0, 8),
            amountAtomic: attempt.rows[0]!.net_amount_atomic,
            assetSymbol: 'USDT',
            correlationReference: 'mismatch',
            mayHaveBroadcast: true,
          },
        }),
      );
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.state).toBe('RECONCILE_REQUIRED');
      const reservedAfter = await userBucketBalance(
        pool,
        userId,
        assetId,
        'USER_RESERVED_LIABILITY',
      );
      expect(reservedAfter).toBe(reservedBefore);
      expect(reservedAfter).toBe(200000n);
    });
  });
});
