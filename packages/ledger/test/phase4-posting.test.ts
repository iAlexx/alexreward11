import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LedgerDomainError,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  phase4DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
  versionOf,
} from './harness.js';

describe.skipIf(phase4DatabaseUrl === '')('Phase 4 ledger posting', () => {
  let pool: Pool;
  let assetId: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase4DatabaseUrl);
    pool = new Pool({ connectionString: phase4DatabaseUrl });
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
    userId = await createTestUser(
      pool,
      String(900_000_000_000 + Math.floor(Math.random() * 1_000_000)),
    );
  });

  it('posts a balanced two-entry reward issuance and updates projections', async () => {
    const result = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const tx = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'test-reward',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'two-entry-1',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '500' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '500' },
        ],
      });
      return { tx, expense, pending };
    });
    expect(result.tx.created).toBe(true);
    expect(result.tx.entries).toHaveLength(2);
    expect(await balanceOf(pool, result.expense.id)).toBe(500n); // debit-normal
    expect(await balanceOf(pool, result.pending.id)).toBe(500n); // credit-normal
    expect(await versionOf(pool, result.pending.id)).toBe(1n);
    const last = await pool.query<{ last_ledger_transaction_id: string }>(
      `SELECT last_ledger_transaction_id FROM ledger_account_balances WHERE ledger_account_id = $1`,
      [result.pending.id],
    );
    expect(last.rows[0]?.last_ledger_transaction_id).toBe(result.tx.id);
  });

  it('posts multi-entry withdrawal settlement shape (synthetic)', async () => {
    const ids = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'seed',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'seed-avail',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '100' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '100' },
        ],
      });
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'REWARD_MATURITY',
        businessReferenceType: 'seed-mat',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'seed-mat',
        assetId,
        entries: [
          { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic: '100' },
          { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic: '100' },
        ],
      });
      const reserved = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_RESERVED_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'WITHDRAWAL_RESERVATION',
        businessReferenceType: 'seed-res',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'seed-res',
        assetId,
        entries: [
          { ledgerAccountId: available.id, direction: 'DEBIT', amountAtomic: '100' },
          { ledgerAccountId: reserved.id, direction: 'CREDIT', amountAtomic: '100' },
        ],
      });
      const walletOwner = randomUUID();
      const hot = await getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_USDT_ASSET',
        assetId,
        ownerId: walletOwner,
      });
      const fee = await getOrCreateLedgerAccount(client, {
        accountType: 'WITHDRAWAL_FEE_REVENUE',
        assetId,
      });
      const settled = await postLedgerTransaction(client, {
        transactionType: 'WITHDRAWAL_SETTLEMENT',
        businessReferenceType: 'seed-settle',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'seed-settle',
        assetId,
        entries: [
          { ledgerAccountId: reserved.id, direction: 'DEBIT', amountAtomic: '100' },
          { ledgerAccountId: hot.id, direction: 'CREDIT', amountAtomic: '90' },
          { ledgerAccountId: fee.id, direction: 'CREDIT', amountAtomic: '10' },
        ],
      });
      expect(settled.entries).toHaveLength(3);
      return { reservedId: reserved.id, hotId: hot.id, feeId: fee.id };
    });
    expect(await balanceOf(pool, ids.reservedId)).toBe(0n);
    expect(await balanceOf(pool, ids.hotId)).toBe(-90n);
    expect(await balanceOf(pool, ids.feeId)).toBe(10n);
  });

  it('rejects unbalanced, zero, negative, and mixed-asset postings', async () => {
    await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await expect(
        postLedgerTransaction(client, {
          transactionType: 'MANUAL_CORRECTION',
          businessReferenceType: 'unbalanced',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'unbalanced',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '10' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '9' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'UNBALANCED' });

      await expect(
        postLedgerTransaction(client, {
          transactionType: 'MANUAL_CORRECTION',
          businessReferenceType: 'zero',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'zero',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '0' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '0' },
          ],
        }),
      ).rejects.toBeInstanceOf(LedgerDomainError);

      await expect(
        postLedgerTransaction(client, {
          transactionType: 'MANUAL_CORRECTION',
          businessReferenceType: 'neg',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'neg',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '-1' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '-1' },
          ],
        }),
      ).rejects.toBeInstanceOf(LedgerDomainError);
    });

    const ton = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'TON'`);
    const tonId = ton.rows[0]?.id;
    if (tonId === undefined) throw new Error('TON missing');
    await withLedgerTransaction(pool, async (client) => {
      const expenseUsdt = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pendingTon = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId: tonId,
        ownerId: userId,
      });
      await expect(
        postLedgerTransaction(client, {
          transactionType: 'MANUAL_CORRECTION',
          businessReferenceType: 'mixed',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'mixed',
          assetId,
          entries: [
            { ledgerAccountId: expenseUsdt.id, direction: 'DEBIT', amountAtomic: '5' },
            { ledgerAccountId: pendingTon.id, direction: 'CREDIT', amountAtomic: '5' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_ASSET_MISMATCH' });
    });
  });

  it('returns the same transaction on exact idempotent retry', async () => {
    const biz = randomUUID();
    const first = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'idem',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'exact-retry',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '40' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '40' },
        ],
      });
    });
    const second = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'idem',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'exact-retry',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '40' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '40' },
        ],
      });
    });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE idempotency_key = 'exact-retry'`,
    );
    expect(count.rows[0]?.c).toBe(1);
    expect(await balanceOf(pool, first.entries[1]!.ledgerAccountId)).toBe(40n);
  });

  it('rejects same idempotency key with different intent', async () => {
    await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'idem-a',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'conflict-key',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '10' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '10' },
        ],
      });
      await expect(
        postLedgerTransaction(client, {
          transactionType: 'REWARD_ISSUANCE',
          businessReferenceType: 'idem-b',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'conflict-key',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '11' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '11' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
  });

  it('rejects duplicate business reference with different intent and recovers same intent', async () => {
    const biz = randomUUID();
    const first = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'biz-ref',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'biz-1',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '7' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '7' },
        ],
      });
    });
    const recovered = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'biz-ref',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'biz-1',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '7' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '7' },
        ],
      });
    });
    expect(recovered.id).toBe(first.id);

    await expect(
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
          businessReferenceType: 'biz-ref',
          businessReferenceId: biz,
          idempotencyScope: 'phase4',
          idempotencyKey: 'biz-2-different',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '8' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '8' },
          ],
        });
      }),
    ).rejects.toMatchObject({ code: 'BUSINESS_REFERENCE_CONFLICT' });
  });

  it('rolls back header, entries, and projections on injected failure before commit', async () => {
    await expect(
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
        await postLedgerTransaction(client, {
          transactionType: 'REWARD_ISSUANCE',
          businessReferenceType: 'rollback',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'rollback-1',
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '55' },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '55' },
          ],
        });
        throw new Error('injected-failure-before-commit');
      }),
    ).rejects.toThrow(/injected-failure-before-commit/);

    const txs = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE idempotency_key = 'rollback-1'`,
    );
    const entries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    expect(txs.rows[0]?.c).toBe(0);
    expect(entries.rows[0]?.c).toBe(0);
  });

  it('provisions MEMBERSHIP_BONUS_EXPENSE classification without issuing bonus domain events', async () => {
    await withLedgerTransaction(pool, async (client) => {
      const bonusExpense = await getOrCreateLedgerAccount(client, {
        accountType: 'MEMBERSHIP_BONUS_EXPENSE',
        assetId,
      });
      expect(bonusExpense.accountClass).toBe('EXPENSE');
      expect(bonusExpense.normalSide).toBe('DEBIT');
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      // Synthetic shape only — no reward_events / Founder rules.
      await postLedgerTransaction(client, {
        transactionType: 'MEMBERSHIP_BONUS_ISSUANCE',
        businessReferenceType: 'phase4-classification-only',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'membership-bonus-shape',
        assetId,
        entries: [
          { ledgerAccountId: bonusExpense.id, direction: 'DEBIT', amountAtomic: '1' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '1' },
        ],
      });
    });
    const events = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM reward_events`);
    expect(events.rows[0]?.c).toBe(0);
  });

  it('treats entry-order permutation as the same idempotent intent', async () => {
    const biz = randomUUID();
    const first = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'order-idem',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'order-idem',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '13' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '13' },
        ],
      });
    });
    const second = await withLedgerTransaction(pool, async (client) => {
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
        businessReferenceType: 'order-idem',
        businessReferenceId: biz,
        idempotencyScope: 'phase4',
        idempotencyKey: 'order-idem',
        assetId,
        entries: [
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '13' },
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '13' },
        ],
      });
    });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
  });

  it('refuses silent TREASURY_FUNDING_CLEARING provision without Owner acknowledgement', async () => {
    await expect(
      withLedgerTransaction(pool, async (client) =>
        getOrCreateLedgerAccount(client, {
          accountType: 'TREASURY_FUNDING_CLEARING',
          assetId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'OWNER_DECISION_REQUIRED' });
  });
});
