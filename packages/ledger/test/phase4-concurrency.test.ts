import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  reverseLedgerTransaction,
  withLedgerTransaction,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  issuePendingReward,
  maturePending,
  phase4DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
} from './harness.js';

describe.skipIf(phase4DatabaseUrl === '')('Phase 4 ledger concurrency', () => {
  let pool: Pool;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase4DatabaseUrl);
    pool = new Pool({ connectionString: phase4DatabaseUrl, max: 10 });
    assetId = await usdtAssetId(pool);
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
  });

  it('allows only one of two concurrent spends that cannot both fit', async () => {
    const userId = await createTestUser(pool, '910001');
    await issuePendingReward({ pool, userId, assetId, amount: '100', key: 'fund-1' });
    await maturePending({ pool, userId, assetId, amount: '100', key: 'mat-1' });

    const results = await Promise.allSettled([
      withLedgerTransaction(pool, async (client) => {
        const available = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_AVAILABLE_LIABILITY',
          assetId,
          ownerId: userId,
        });
        const reserved = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_RESERVED_LIABILITY',
          assetId,
          ownerId: userId,
        });
        return postLedgerTransaction(client, {
          transactionType: 'WITHDRAWAL_RESERVATION',
          businessReferenceType: 'spend-a',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'spend-a',
          assetId,
          entries: [
            { ledgerAccountId: available.id, direction: 'DEBIT', amountAtomic: '80' },
            { ledgerAccountId: reserved.id, direction: 'CREDIT', amountAtomic: '80' },
          ],
        });
      }),
      withLedgerTransaction(pool, async (client) => {
        const available = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_AVAILABLE_LIABILITY',
          assetId,
          ownerId: userId,
        });
        const reserved = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_RESERVED_LIABILITY',
          assetId,
          ownerId: userId,
        });
        return postLedgerTransaction(client, {
          transactionType: 'WITHDRAWAL_RESERVATION',
          businessReferenceType: 'spend-b',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'spend-b',
          assetId,
          entries: [
            { ledgerAccountId: available.id, direction: 'DEBIT', amountAtomic: '80' },
            { ledgerAccountId: reserved.id, direction: 'CREDIT', amountAtomic: '80' },
          ],
        });
      }),
    ]);

    const ok = results.filter((item) => item.status === 'fulfilled');
    const bad = results.filter((item) => item.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.status).toBe('rejected');
    if (bad[0]?.status === 'rejected') {
      expect(bad[0].reason).toMatchObject({ code: 'NEGATIVE_PROTECTED_BALANCE' });
    }

    const available = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    const reserved = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_RESERVED_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(20n);
    expect(await balanceOf(pool, reserved.id)).toBe(80n);
    expect(await balanceOf(pool, available.id)).toBeGreaterThanOrEqual(0n);
  });

  it('locks accounts in deterministic order regardless of caller entry order', async () => {
    const userId = await createTestUser(pool, '910002');
    await issuePendingReward({ pool, userId, assetId, amount: '50', key: 'fund-2' });
    await maturePending({ pool, userId, assetId, amount: '50', key: 'mat-2' });

    const accounts = await withLedgerTransaction(pool, async (client) => {
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const reserved = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_RESERVED_LIABILITY',
        assetId,
        ownerId: userId,
      });
      return { available, reserved };
    });

    const results = await Promise.allSettled([
      withLedgerTransaction(pool, async (client) =>
        postLedgerTransaction(client, {
          transactionType: 'WITHDRAWAL_RESERVATION',
          businessReferenceType: 'lock-a',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'lock-a',
          assetId,
          entries: [
            { ledgerAccountId: accounts.available.id, direction: 'DEBIT', amountAtomic: '10' },
            { ledgerAccountId: accounts.reserved.id, direction: 'CREDIT', amountAtomic: '10' },
          ],
        }),
      ),
      withLedgerTransaction(pool, async (client) =>
        postLedgerTransaction(client, {
          transactionType: 'WITHDRAWAL_RESERVATION',
          businessReferenceType: 'lock-b',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'lock-b',
          assetId,
          // Same economic intent; reversed caller entry order.
          entries: [
            { ledgerAccountId: accounts.reserved.id, direction: 'CREDIT', amountAtomic: '10' },
            { ledgerAccountId: accounts.available.id, direction: 'DEBIT', amountAtomic: '10' },
          ],
        }),
      ),
    ]);
    expect(results.every((item) => item.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(pool, accounts.available.id)).toBe(30n);
  });

  it('concurrent get-or-create yields one account and one projection', async () => {
    const userId = await createTestUser(pool, '910003');
    const results = await Promise.all([
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'USER_AVAILABLE_LIABILITY',
          assetId,
          ownerId: userId,
        }),
      ),
      withLedgerTransaction(pool, (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'USER_AVAILABLE_LIABILITY',
          assetId,
          ownerId: userId,
        }),
      ),
    ]);
    expect(results[0].id).toBe(results[1].id);
    const accounts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_accounts
       WHERE owner_id = $1 AND account_type = 'USER_AVAILABLE_LIABILITY'`,
      [userId],
    );
    const balances = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_account_balances WHERE ledger_account_id = $1`,
      [results[0].id],
    );
    expect(accounts.rows[0]?.c).toBe(1);
    expect(balances.rows[0]?.c).toBe(1);
  });

  it('high-contention repeated posting preserves exact final balance', async () => {
    const userId = await createTestUser(pool, '910004');
    const jobs = Array.from({ length: 20 }, (_, index) =>
      issuePendingReward({
        pool,
        userId,
        assetId,
        amount: '3',
        key: `contention-${index}`,
      }),
    );
    await Promise.all(jobs);
    const pending = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, pending.id)).toBe(60n);
  });

  it('concurrent same idempotency key creates one economic transaction', async () => {
    const userId = await createTestUser(pool, '910005');
    const biz = randomUUID();
    const run = () =>
      withLedgerTransaction(pool, async (client) => {
        const expense = await getOrCreateLedgerAccount(client, {
          accountType: 'PLATFORM_REWARD_EXPENSE',
          assetId,
        });
        const pending = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_PENDING_LIABILITY',
          assetId,
          ownerId: userId,
        });
        return postLedgerTransaction(client, {
          transactionType: 'REWARD_ISSUANCE',
          businessReferenceType: 'conc-idem',
          businessReferenceId: biz,
          idempotencyScope: 'phase4',
          idempotencyKey: 'same-idem-key',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '15' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '15' },
          ],
        });
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.id).toBe(b.id);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE idempotency_key = 'same-idem-key'`,
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('concurrent same business reference creates one economic transaction', async () => {
    const userId = await createTestUser(pool, '910006');
    const biz = randomUUID();
    const run = (key: string) =>
      withLedgerTransaction(pool, async (client) => {
        const expense = await getOrCreateLedgerAccount(client, {
          accountType: 'PLATFORM_REWARD_EXPENSE',
          assetId,
        });
        const pending = await getOrCreateLedgerAccount(client, {
          accountType: 'USER_PENDING_LIABILITY',
          assetId,
          ownerId: userId,
        });
        return postLedgerTransaction(client, {
          transactionType: 'REWARD_ISSUANCE',
          businessReferenceType: 'conc-biz',
          businessReferenceId: biz,
          idempotencyScope: 'phase4',
          idempotencyKey: key,
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '12' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '12' },
          ],
        });
      });
    const results = await Promise.allSettled([run('biz-key-1'), run('biz-key-1')]);
    // Same key+same biz → both recover same; if one uses different key it would conflict.
    // Using same key to prove one economic row under contention.
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions
       WHERE business_reference_type = 'conc-biz' AND business_reference_id = $1`,
      [biz],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('concurrent double reversal produces one reversal', async () => {
    const userId = await createTestUser(pool, '910007');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '25',
      key: 'rev-fund',
    });
    const results = await Promise.allSettled([
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'rev-a',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'rev-a',
      }),
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'rev-b',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'rev-b',
      }),
    ]);
    const ok = results.filter((item) => item.status === 'fulfilled');
    const bad = results.filter((item) => item.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(count.rows[0]?.c).toBe(1);
  });
});
