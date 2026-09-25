/**
 * Isolated aalex settlement accounting — disposable PHASE7 DB only.
 * Verifies asset-aware Hot Wallet inventory (HOT_WALLET_JETTON_ASSET) without
 * changing USDT HOT_WALLET_USDT_ASSET behavior.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  checkLedgerInvariants,
  getOrCreateLedgerAccount,
  withLedgerTransaction,
} from '@alex-rewards/ledger';

import {
  PROPOSED_ISOLATED_AALEX_WITHDRAWAL,
  FakePayoutChain,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  localWithdrawalEngineFixtureConfig,
  runFakePayoutPipeline,
  seedProposedIsolatedAalexWithdrawalRules,
  settleWithdrawalReservation,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  approveWithdrawal,
  assertLedgerBalanced,
  bindVerifiedPrimaryWallet,
  createTestUser,
  engineConfig,
  fundUserAvailable,
  phase7DatabaseUrl,
  platformAccountBalance,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

const GROSS = '1000000000';
const FEE = '10000000';
const NET = '990000000';

describe.skipIf(phase7DatabaseUrl === '')('aalex settlement accounting', () => {
  let pool: Pool;
  let networkId: string;
  let aalexAssetId: string;
  let usdtAssetId: string;
  let adminUserId: string;
  let hotWalletId: string;

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
    networkId = base.networkId;
    usdtAssetId = base.assetId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;

    await pool.query(`DELETE FROM assets WHERE symbol = 'aalex' AND network_id = $1::uuid`, [
      networkId,
    ]);
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         network_id, symbol, name, decimals, is_native, contract_identity, status
       ) VALUES (
         $1::uuid, 'aalex', 'Isolated aalex', 9, false, $2, 'ACTIVE'
       )
       RETURNING id`,
      [networkId, PROPOSED_ISOLATED_AALEX_WITHDRAWAL.contractIdentity],
    );
    aalexAssetId = asset.rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      await seedProposedIsolatedAalexWithdrawalRules(client, {
        assetId: aalexAssetId,
        networkId,
      });
    });
  });

  async function fundHotWalletJetton(amountAtomic: string): Promise<void> {
    await withLedgerTransaction(pool, async (client) => {
      const hot = await getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_JETTON_ASSET',
        assetId: aalexAssetId,
        ownerId: hotWalletId,
      });
      const treasury = await getOrCreateLedgerAccount(client, {
        accountType: 'TREASURY_FUNDING_CLEARING',
        assetId: aalexAssetId,
        acknowledgeUnresolvedAccounting: true,
      });
      const { postLedgerTransaction } = await import('@alex-rewards/ledger');
      await postLedgerTransaction(client, {
        transactionType: 'HOT_WALLET_FUNDING',
        businessReferenceType: 'aalex-settle-hot-fund',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'aalex-settle-hot-fund',
        idempotencyKey: randomUUID(),
        assetId: aalexAssetId,
        entries: [
          { ledgerAccountId: hot.id, direction: 'DEBIT', amountAtomic },
          { ledgerAccountId: treasury.id, direction: 'CREDIT', amountAtomic },
        ],
      });
    });
  }

  async function createApprovedAalexWithdrawal(userId: string): Promise<string> {
    const aalexConfig = localWithdrawalEngineFixtureConfig({
      usdtSymbol: 'aalex',
      fakeChainEnabled: true,
    });
    await fundUserAvailable({
      pool,
      userId,
      assetId: aalexAssetId,
      amountAtomic: GROSS,
      key: randomUUID(),
    });
    await fundHotWalletJetton('5000000000');
    const quote = await createWithdrawalQuote(pool, aalexConfig, {
      authenticatedUserId: userId,
      amountAtomic: GROSS,
    });
    expect(quote.feeAmountAtomic).toBe(FEE);
    expect(quote.netAmountAtomic).toBe(NET);
    const withdrawal = await createWithdrawalFromQuote(pool, aalexConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });
    await approveWithdrawal(pool, adminUserId, withdrawal.id, undefined, aalexConfig);
    return withdrawal.id;
  }

  it('settles 1 aalex via HOT_WALLET_JETTON_ASSET with proof; idempotent retry', async () => {
    const userId = await createTestUser(pool, '991001');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedAalexWithdrawal(userId);
    const aalexConfig = localWithdrawalEngineFixtureConfig({
      usdtSymbol: 'aalex',
      fakeChainEnabled: true,
    });

    const feeBefore = await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', aalexAssetId);
    const hotBefore = await withLedgerTransaction(pool, async (client) => {
      const hot = await getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_JETTON_ASSET',
        assetId: aalexAssetId,
        ownerId: hotWalletId,
      });
      const bal = await client.query<{ balance_atomic: string }>(
        `SELECT balance_atomic::text FROM ledger_account_balances WHERE ledger_account_id = $1`,
        [hot.id],
      );
      return { id: hot.id, balance: BigInt(bal.rows[0]?.balance_atomic ?? '0') };
    });

    const fakeChain = new FakePayoutChain(aalexConfig);
    const result = await runFakePayoutPipeline(pool, aalexConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    expect(result.state).toBe('CONFIRMED');

    expect(await userBucketBalance(pool, userId, aalexAssetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
    expect(await userBucketBalance(pool, userId, aalexAssetId, 'USER_AVAILABLE_LIABILITY')).toBe(0n);

    const feeAfter = await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', aalexAssetId);
    expect(feeAfter - feeBefore).toBe(10_000_000n);

    const hotAfter = await withLedgerTransaction(pool, async (client) => {
      const bal = await client.query<{ balance_atomic: string; account_type: string }>(
        `SELECT b.balance_atomic::text, a.account_type::text
         FROM ledger_accounts a
         INNER JOIN ledger_account_balances b ON b.ledger_account_id = a.id
         WHERE a.id = $1::uuid`,
        [hotBefore.id],
      );
      return {
        balance: BigInt(bal.rows[0]?.balance_atomic ?? '0'),
        accountType: bal.rows[0]?.account_type,
      };
    });
    expect(hotAfter.accountType).toBe('HOT_WALLET_JETTON_ASSET');
    expect(hotBefore.balance - hotAfter.balance).toBe(990_000_000n);

    // No cross-asset: USDT fee revenue unchanged by aalex settlement.
    expect(await platformAccountBalance(pool, 'WITHDRAWAL_FEE_REVENUE', usdtAssetId)).toBe(0n);

    const entries = await pool.query<{
      account_type: string;
      direction: string;
      amount_atomic: string;
      asset_id: string;
    }>(
      `SELECT a.account_type::text, e.direction::text, e.amount_atomic::text,
              a.asset_id::text
       FROM ledger_entries e
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       INNER JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       WHERE t.transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND t.business_reference_id = $1::uuid
       ORDER BY e.entry_index`,
      [withdrawalId],
    );
    expect(entries.rows).toEqual([
      {
        account_type: 'USER_RESERVED_LIABILITY',
        direction: 'DEBIT',
        amount_atomic: GROSS,
        asset_id: aalexAssetId,
      },
      {
        account_type: 'HOT_WALLET_JETTON_ASSET',
        direction: 'CREDIT',
        amount_atomic: NET,
        asset_id: aalexAssetId,
      },
      {
        account_type: 'WITHDRAWAL_FEE_REVENUE',
        direction: 'CREDIT',
        amount_atomic: FEE,
        asset_id: aalexAssetId,
      },
    ]);

    const settlementId = (
      await pool.query<{ settlement_ledger_tx_id: string }>(
        `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
        [withdrawalId],
      )
    ).rows[0]!.settlement_ledger_tx_id;

    await withWithdrawalTransaction(pool, async (client) => {
      const again = await settleWithdrawalReservation(client, { withdrawalId });
      expect(again.settled).toBe(false);
      expect(again.ledgerTxId).toBe(settlementId);
    });

    const txCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(txCount.rows[0]?.c).toBe('1');

    await assertLedgerBalanced(pool);
    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(true);
    expect(invariants.findings.filter((f) => f.severity === 'CRITICAL')).toEqual([]);
  });

  it('refuses settlement without evidence-backed confirmed attempt', async () => {
    const userId = await createTestUser(pool, '991002');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedAalexWithdrawal(userId);

    // Force CONFIRMED without reconciliation proof — settle must fail closed.
    await pool.query(
      `UPDATE withdrawals SET state = 'CONFIRMED', updated_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    await expect(
      withWithdrawalTransaction(pool, (client) =>
        settleWithdrawalReservation(client, { withdrawalId }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });

    const txCount = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(txCount.rows[0]?.c).toBe('0');
    expect(await userBucketBalance(pool, userId, aalexAssetId, 'USER_RESERVED_LIABILITY')).toBe(
      1_000_000_000n,
    );
  });

  it('USDT settlement still uses HOT_WALLET_USDT_ASSET', async () => {
    const userId = await createTestUser(pool, '991003');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    await fundUserAvailable({
      pool,
      userId,
      assetId: usdtAssetId,
      amountAtomic: '5000000',
      key: randomUUID(),
    });
    await withLedgerTransaction(pool, async (client) => {
      const { postLedgerTransaction } = await import('@alex-rewards/ledger');
      const hot = await getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_USDT_ASSET',
        assetId: usdtAssetId,
        ownerId: hotWalletId,
      });
      const treasury = await getOrCreateLedgerAccount(client, {
        accountType: 'TREASURY_FUNDING_CLEARING',
        assetId: usdtAssetId,
        acknowledgeUnresolvedAccounting: true,
      });
      await postLedgerTransaction(client, {
        transactionType: 'HOT_WALLET_FUNDING',
        businessReferenceType: 'usdt-settle-hot-fund',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'usdt-settle-hot-fund',
        idempotencyKey: randomUUID(),
        assetId: usdtAssetId,
        entries: [
          { ledgerAccountId: hot.id, direction: 'DEBIT', amountAtomic: '10000000' },
          { ledgerAccountId: treasury.id, direction: 'CREDIT', amountAtomic: '10000000' },
        ],
      });
    });

    const quote = await createWithdrawalQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const withdrawal = await createWithdrawalFromQuote(pool, engineConfig, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });
    await approveWithdrawal(pool, adminUserId, withdrawal.id);

    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId: withdrawal.id,
      scenario: 'CONFIRMED_SUCCESS',
    });
    expect(result.state).toBe('CONFIRMED');

    const hotType = await pool.query<{ account_type: string }>(
      `SELECT a.account_type::text
       FROM ledger_entries e
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       INNER JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       WHERE t.transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND t.business_reference_id = $1::uuid
         AND a.account_type = 'HOT_WALLET_USDT_ASSET'`,
      [withdrawal.id],
    );
    expect(hotType.rowCount).toBe(1);

    const jettonLeak = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM ledger_entries e
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       INNER JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       WHERE t.business_reference_id = $1::uuid
         AND a.account_type = 'HOT_WALLET_JETTON_ASSET'`,
      [withdrawal.id],
    );
    expect(jettonLeak.rows[0]?.c).toBe('0');
  });
});
