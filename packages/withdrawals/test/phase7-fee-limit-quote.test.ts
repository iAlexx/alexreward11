import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WithdrawalDomainError } from '../src/index.js';
import {
  LOCKED_INITIAL_WITHDRAWAL,
  cancelWithdrawalQuote,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  expireWithdrawalQuote,
  resolveActiveFeeRule,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  bindVerifiedPrimaryWallet,
  claimFounderForUser,
  createTestUser,
  engineConfig,
  phase7DatabaseUrl,
  resetAndMigrate,
  fundUserAvailable,
  seedFounderFeeDiscount,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 fee/limit quote', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
  });

  it('documents locked initial constants', () => {
    expect(LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic).toBe(200_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic).toBe(10_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic).toBe(5_000_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.maxUserHourlyAtomic).toBe(5_000_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.maxUserDailyAtomic).toBe(10_000_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.maxHotWalletHourlyAtomic).toBe(25_000_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.maxHotWalletDailyAtomic).toBe(100_000_000n);
    expect(LOCKED_INITIAL_WITHDRAWAL.walletChangeCooldownSeconds).toBe(86_400);
  });

  it('applies fixed 0.01 fee: 0.20 gross → fee 0.01 → net 0.19', async () => {
    const userId = await createTestUser(pool, '7001');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });

    expect(quote.requestedAmountAtomic).toBe('200000');
    expect(quote.basePlatformFeeAtomic).toBe('10000');
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.netAmountAtomic).toBe('190000');
    expect(quote.membershipFeeDiscountBps).toBe(0);
    expect(quote.status).toBe('OPEN');
  });

  it('rejects below min; accepts exactly 0.20; rejects above max single', async () => {
    const userId = await createTestUser(pool, '7002');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '199999',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' } satisfies Partial<WithdrawalDomainError>);

    const ok = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: LOCKED_INITIAL_WITHDRAWAL.minWithdrawalAtomic.toString(10),
    });
    expect(ok.requestedAmountAtomic).toBe('200000');

    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: (LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic + 1n).toString(10),
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects net<=0 when gross equals fee', async () => {
    const userId = await createTestUser(pool, '7003');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    // Supersede fixed fee with min-withdrawal-sized fee so net would be 0.
    await pool.query(
      `UPDATE withdrawal_fee_rules
       SET status = 'SUPERSEDED', valid_to = now(), updated_at = now()
       WHERE asset_id = $1::uuid AND network_id = $2::uuid AND status = 'ACTIVE'`,
      [assetId, networkId],
    );
    await pool.query(
      `INSERT INTO withdrawal_fee_rules (
         asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 2, 200000, 0, 'ACTIVE', now(), 'PHASE7 net<=0 probe'
       )`,
      [assetId, networkId],
    );

    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' } satisfies Partial<WithdrawalDomainError>);
  });

  it('freezes fee rule on quote; newer fee version does not change consumed amounts', async () => {
    const userId = await createTestUser(pool, '7004');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.feeRuleVersion).toBe(1);

    await pool.query(
      `UPDATE withdrawal_fee_rules
       SET status = 'SUPERSEDED', valid_to = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [quote.feeRuleId],
    );
    await pool.query(
      `INSERT INTO withdrawal_fee_rules (
         asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
         status, valid_from, reason
       ) VALUES (
         $1::uuid, $2::uuid, 2, 50000, 0, 'ACTIVE', now(), 'PHASE7 newer fee'
       )`,
      [assetId, networkId],
    );

    // Re-read quote row still frozen
    const frozen = await pool.query<{
      fee_amount_atomic: string;
      fee_rule_version: number;
    }>(
      `SELECT fee_amount_atomic::text, fee_rule_version FROM withdrawal_quotes WHERE id = $1::uuid`,
      [quote.id],
    );
    expect(frozen.rows[0]?.fee_amount_atomic).toBe('10000');
    expect(frozen.rows[0]?.fee_rule_version).toBe(1);

    const fresh = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(fresh.feeAmountAtomic).toBe('50000');
    expect(fresh.feeRuleVersion).toBe(2);
  });

  it('ambiguous ACTIVE fee rules fail closed (EXCLUDE or resolve)', async () => {
    let insertBlocked = false;
    try {
      await pool.query(
        `INSERT INTO withdrawal_fee_rules (
           asset_id, network_id, rule_version, fixed_fee_atomic, percentage_bps,
           status, valid_from, reason
         ) VALUES (
           $1::uuid, $2::uuid, 99, 10000, 0, 'ACTIVE', now(), 'PHASE7 overlap probe'
         )`,
        [assetId, networkId],
      );
    } catch (error) {
      insertBlocked = true;
      expect(error).toBeTruthy();
    }

    if (!insertBlocked) {
      await expect(
        withWithdrawalTransaction(pool, async (client) =>
          resolveActiveFeeRule(client, { assetId, networkId, asOf: new Date() }),
        ),
      ).rejects.toMatchObject({ code: 'FEE_RULE_AMBIGUOUS' });
    } else {
      // Overlap safety at DB is also a PASS for Owner matrix.
      expect(insertBlocked).toBe(true);
    }
  });

  it('STANDARD user without benefit pays base fee', async () => {
    const userId = await createTestUser(pool, '7005');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const plan = await pool.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
    );
    await pool.query(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, status, source, claimed_at
       ) VALUES ($1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now())`,
      [userId, plan.rows[0]!.id],
    );

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.membershipFeeDiscountBps).toBe(0);
  });

  it('Founder membership without fee entitlement pays base fee', async () => {
    const userId = await createTestUser(pool, '7006');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.membershipFeeDiscountBps).toBe(0);
  });

  it('synthetic fee-discount entitlement applies; 10000 bps → zero fee', async () => {
    const userId = await createTestUser(pool, '7007');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await withWithdrawalTransaction(pool, async (client) => {
      await seedFounderFeeDiscount(client, { discountBps: 5000, assetId });
    });

    const half = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(half.basePlatformFeeAtomic).toBe('10000');
    expect(half.membershipFeeDiscountBps).toBe(5000);
    expect(half.feeAmountAtomic).toBe('5000');
    expect(half.netAmountAtomic).toBe('495000');

    // Replace with full waiver (new rule version after closing prior entitlement window)
    await pool.query(
      `UPDATE membership_plan_entitlements SET status = 'SUPERSEDED', valid_to = now()`,
    );
    await pool.query(
      `UPDATE membership_benefit_rule_versions SET status = 'SUPERSEDED', effective_to = now()`,
    );
    await withWithdrawalTransaction(pool, async (client) => {
      await seedFounderFeeDiscount(client, { discountBps: 10_000, assetId, ruleVersion: 2 });
    });

    const zero = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(zero.membershipFeeDiscountBps).toBe(10_000);
    expect(zero.feeAmountAtomic).toBe('0');
    expect(zero.netAmountAtomic).toBe('500000');
  });

  it('expired fee benefit is ignored', async () => {
    const userId = await createTestUser(pool, '7008');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await withWithdrawalTransaction(pool, async (client) => {
      const plan = await client.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
      );
      const ent = await client.query<{ id: string }>(
        `SELECT id FROM entitlements WHERE code = 'WITHDRAWAL_PLATFORM_FEE_DISCOUNT'`,
      );
      const version = await client.query<{ id: string }>(
        `INSERT INTO membership_benefit_rule_versions (
           entitlement_id, membership_plan_id, rule_version, value_bps, asset_id,
           status, effective_from, effective_to, reason
         ) VALUES (
           $1::uuid, $2::uuid, 1, 5000, $3::uuid,
           'SUPERSEDED', now() - interval '2 hours', now() - interval '1 hour',
           'PHASE7 expired fee discount'
         )
         RETURNING id`,
        [ent.rows[0]!.id, plan.rows[0]!.id, assetId],
      );
      await client.query(
        `INSERT INTO membership_plan_entitlements (
           membership_plan_id, entitlement_id, rule_version_id, valid_from, valid_to, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           now() - interval '2 hours', now() - interval '1 hour', 'SUPERSEDED'
         )`,
        [plan.rows[0]!.id, ent.rows[0]!.id, version.rows[0]!.id],
      );
    });

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '500000',
    });
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.membershipFeeDiscountBps).toBe(0);
  });

  it('ambiguous discount candidates fail closed', async () => {
    const userId = await createTestUser(pool, '7009');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);

    // Also grant STANDARD membership with a competing fee discount.
    const standard = await pool.query<{ id: string }>(
      `SELECT id FROM membership_plans WHERE code = 'STANDARD'`,
    );
    await pool.query(
      `INSERT INTO user_memberships (
         user_id, membership_plan_id, status, source, claimed_at
       ) VALUES ($1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now())`,
      [userId, standard.rows[0]!.id],
    );

    const founderOk = await (async () => {
      try {
        await withWithdrawalTransaction(pool, async (client) => {
          await seedFounderFeeDiscount(client, {
            discountBps: 1000,
            assetId,
            planCode: 'FOUNDER_LIFETIME',
          });
        });
        return true;
      } catch {
        return false;
      }
    })();
    const standardOk = await (async () => {
      try {
        await withWithdrawalTransaction(pool, async (client) => {
          await seedFounderFeeDiscount(client, {
            discountBps: 2000,
            assetId,
            planCode: 'STANDARD',
            ruleVersion: 1,
          });
        });
        return true;
      } catch {
        return false;
      }
    })();

    if (founderOk && standardOk) {
      await expect(
        createWithdrawalQuote(pool, engineConfig, {
          authenticatedUserId: userId,
          amountAtomic: '500000',
        }),
      ).rejects.toMatchObject({ code: 'ENTITLEMENT_AMBIGUOUS' });
    } else {
      // DB EXCLUDE / uniqueness also fail-closed for overlap.
      expect(founderOk || standardOk).toBe(true);
    }
  });

  it('cancel/expire/consume once; cancel idempotent; expired cannot consume', async () => {
    const userId = await createTestUser(pool, '7010');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const cancelQuote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '300000',
    });
    const cancelled = await cancelWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: cancelQuote.id,
    });
    expect(cancelled.status).toBe('CANCELLED');
    const cancelledAgain = await cancelWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: cancelQuote.id,
    });
    expect(cancelledAgain.status).toBe('CANCELLED');

    const expireQuote = await createWithdrawalQuote(
      pool,
      { ...engineConfig, quoteTtlSeconds: 1 },
      { authenticatedUserId: userId, amountAtomic: '300000' },
    );
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await expireWithdrawalQuote(pool, expireQuote.id);
    expect(expired).toBe(true);
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: expireQuote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: /QUOTE_EXPIRED|QUOTE_NOT_OPEN/ });

    // Consume once
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    const consumeQuote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: consumeQuote.id,
      idempotencyKey: randomUUID(),
    });
    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: consumeQuote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: /QUOTE_CONSUMED|IDEMPOTENCY_CONFLICT/ });
  });

  it('wallet change after quote forces requote', async () => {
    const userId = await createTestUser(pool, '7011');
    const firstWallet = await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    expect(quote.primaryWalletId).toBe(firstWallet);

    await pool.query(`UPDATE user_wallets SET is_primary = false WHERE id = $1::uuid`, [
      firstWallet,
    ]);
    const suffix = randomUUID().replace(/-/g, '');
    const raw = `0:${suffix}`;
    await pool.query(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, $4,
         true, true, 'TON_PROOF', now(), now()
       )`,
      [userId, networkId, raw, `EQ${raw.slice(2, 50)}`],
    );

    await expect(
      createWithdrawalFromQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        quoteId: quote.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_INELIGIBLE' });
  });

  it('SQL mutation of quote money is rejected by trigger', async () => {
    const userId = await createTestUser(pool, '7012');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });

    await expect(
      pool.query(`UPDATE withdrawal_quotes SET fee_amount_atomic = 1 WHERE id = $1::uuid`, [
        quote.id,
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it('limits use gross; fee discount does not change limit amount used', async () => {
    const userId = await createTestUser(pool, '7013');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await claimFounderForUser(pool, userId);
    await withWithdrawalTransaction(pool, async (client) => {
      await seedFounderFeeDiscount(client, { discountBps: 10_000, assetId });
    });

    // With zero fee, net == gross; max single still applies to gross.
    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: (LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic + 1n).toString(10),
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    const ok = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: LOCKED_INITIAL_WITHDRAWAL.maxSingleWithdrawalAtomic.toString(10),
    });
    expect(ok.requestedAmountAtomic).toBe('5000000');
    expect(ok.feeAmountAtomic).toBe('0');
    expect(ok.netAmountAtomic).toBe('5000000');
  });

  it('rejects quote when primary wallet missing', async () => {
    const userId = await createTestUser(pool, '7014');
    await expect(
      createWithdrawalQuote(pool, engineConfig, {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_INELIGIBLE' });
  });
});
