import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '../src/index.js';
import {
  createTestUser,
  phase4DatabaseUrl,
  resetAndMigrate,
  tonAssetId,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase4DatabaseUrl === '')('Phase 4 account-type / asset compatibility', () => {
  let pool: Pool;
  let usdtId: string;
  let tonId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase4DatabaseUrl);
    pool = new Pool({ connectionString: phase4DatabaseUrl });
    usdtId = await usdtAssetId(pool);
    tonId = await tonAssetId(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        ledger_entries,
        ledger_account_balances,
        ledger_transactions,
        ledger_accounts,
        users
      RESTART IDENTITY CASCADE
    `);
    // Restore asset status in case a prior test disabled one.
    await pool.query(`UPDATE assets SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [
      [usdtId, tonId],
    ]);
  });

  it('rejects HOT_WALLET_USDT_ASSET with native TON asset', async () => {
    await expect(
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'HOT_WALLET_USDT_ASSET',
          assetId: tonId,
          ownerId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_INCOMPATIBLE' });
  });

  it('rejects HOT_WALLET_TON_ASSET with USDT asset', async () => {
    await expect(
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'HOT_WALLET_TON_ASSET',
          assetId: usdtId,
          ownerId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_INCOMPATIBLE' });
  });

  it('rejects TON_NETWORK_FEE_EXPENSE with USDT asset', async () => {
    await expect(
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'TON_NETWORK_FEE_EXPENSE',
          assetId: usdtId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_INCOMPATIBLE' });
  });

  it('provisions proper USDT hot-wallet and native TON hot-wallet accounts', async () => {
    const usdtHot = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_USDT_ASSET',
        assetId: usdtId,
        ownerId: randomUUID(),
      }),
    );
    const tonHot = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_TON_ASSET',
        assetId: tonId,
        ownerId: randomUUID(),
      }),
    );
    expect(usdtHot.assetId).toBe(usdtId);
    expect(tonHot.assetId).toBe(tonId);
  });

  it('rejects provisioning and posting against a DISABLED asset', async () => {
    await pool.query(`UPDATE assets SET status = 'DISABLED' WHERE id = $1`, [usdtId]);
    await expect(
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'PLATFORM_REWARD_EXPENSE',
          assetId: usdtId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_INACTIVE' });

    await pool.query(`UPDATE assets SET status = 'ACTIVE' WHERE id = $1`, [usdtId]);
    const userId = await createTestUser(pool, '940001');
    const accounts = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId: usdtId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId: usdtId,
        ownerId: userId,
      });
      return { expense, pending };
    });
    await pool.query(`UPDATE assets SET status = 'DISABLED' WHERE id = $1`, [usdtId]);
    await expect(
      postLedgerTransaction(pool, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'disabled-asset',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'disabled-asset',
        assetId: usdtId,
        entries: [
          { ledgerAccountId: accounts.expense.id, direction: 'DEBIT', amountAtomic: '1' },
          { ledgerAccountId: accounts.pending.id, direction: 'CREDIT', amountAtomic: '1' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ASSET_INACTIVE' });
  });
});
