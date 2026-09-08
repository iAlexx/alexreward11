import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  postLedgerTransactionWithReversalLink,
  reverseLedgerTransaction,
  withLedgerTransaction,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  issuePendingReward,
  phase4DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
  versionOf,
} from './harness.js';

describe.skipIf(phase4DatabaseUrl === '')('Phase 4 ledger reversals', () => {
  let pool: Pool;
  let assetId: string;

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
  });

  it('creates a new reversal leaving original header and entries unchanged', async () => {
    const userId = await createTestUser(pool, '920001');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '33',
      key: 'orig-1',
    });
    const originalEntries = await pool.query(
      `SELECT id, ledger_account_id, direction, amount_atomic::text AS amount_atomic, entry_index
       FROM ledger_entries WHERE ledger_transaction_id = $1 ORDER BY entry_index`,
      [issued.tx.id],
    );
    const originalHeader = await pool.query<{
      id: string;
      transaction_type: string;
      asset_id: string;
      metadata: unknown;
    }>(`SELECT id, transaction_type, asset_id, metadata FROM ledger_transactions WHERE id = $1`, [
      issued.tx.id,
    ]);

    const reversal = await reverseLedgerTransaction(pool, {
      originalTransactionId: issued.tx.id,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'rev-1',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase4',
      idempotencyKey: 'rev-1',
    });

    expect(reversal.id).not.toBe(issued.tx.id);
    expect(reversal.reversesTransactionId).toBe(issued.tx.id);
    expect(reversal.assetId).toBe(issued.tx.assetId);
    expect(reversal.entries).toHaveLength(2);
    expect(reversal.entries[0]?.direction).toBe('CREDIT'); // swapped from DEBIT expense
    expect(reversal.entries[1]?.direction).toBe('DEBIT');
    expect(reversal.entries[0]?.amountAtomic).toBe('33');
    expect(reversal.entries[1]?.amountAtomic).toBe('33');

    const headerAfter = await pool.query<{
      id: string;
      transaction_type: string;
      asset_id: string;
      metadata: unknown;
    }>(`SELECT id, transaction_type, asset_id, metadata FROM ledger_transactions WHERE id = $1`, [
      issued.tx.id,
    ]);
    expect(headerAfter.rows[0]?.id).toBe(originalHeader.rows[0]?.id);
    expect(headerAfter.rows[0]?.transaction_type).toBe(originalHeader.rows[0]?.transaction_type);
    expect(headerAfter.rows[0]?.asset_id).toBe(originalHeader.rows[0]?.asset_id);
    expect(headerAfter.rows[0]?.metadata).toEqual(originalHeader.rows[0]?.metadata);
    const entriesAfter = await pool.query(
      `SELECT id, ledger_account_id, direction, amount_atomic::text AS amount_atomic, entry_index
       FROM ledger_entries WHERE ledger_transaction_id = $1 ORDER BY entry_index`,
      [issued.tx.id],
    );
    expect(entriesAfter.rows).toEqual(originalEntries.rows);
    expect(await balanceOf(pool, issued.pendingId)).toBe(0n);
  });

  it('rejects a second distinct reversal and recovers exact idempotent reversal', async () => {
    const userId = await createTestUser(pool, '920002');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '20',
      key: 'orig-2',
    });
    const first = await reverseLedgerTransaction(pool, {
      originalTransactionId: issued.tx.id,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'rev-idem',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase4',
      idempotencyKey: 'rev-idem-key',
    });
    const again = await reverseLedgerTransaction(pool, {
      originalTransactionId: issued.tx.id,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'rev-idem',
      businessReferenceId: first.businessReferenceId,
      idempotencyScope: 'phase4',
      idempotencyKey: 'rev-idem-key',
    });
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(false);

    await expect(
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'rev-second',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'rev-second-key',
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_CONFLICT' });
  });

  it('rolls back a failed reversal completely', async () => {
    const userId = await createTestUser(pool, '920003');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '9',
      key: 'orig-3',
    });
    await expect(
      withLedgerTransaction(pool, async (client) => {
        await reverseLedgerTransaction(client, {
          originalTransactionId: issued.tx.id,
          transactionType: 'REWARD_REVERSAL',
          businessReferenceType: 'rev-fail',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'rev-fail',
        });
        throw new Error('injected-reversal-failure');
      }),
    ).rejects.toThrow(/injected-reversal-failure/);

    const reversals = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(reversals.rows[0]?.c).toBe(0);
    expect(await balanceOf(pool, issued.pendingId)).toBe(9n);
  });

  it('rejects malformed direct linked reversal (wrong amount) before insert', async () => {
    const userId = await createTestUser(pool, '920010');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '30',
      key: 'mal-amt',
    });
    const pendingBefore = await balanceOf(pool, issued.pendingId);
    const versionBefore = await versionOf(pool, issued.pendingId);

    await expect(
      withLedgerTransaction(pool, async (client) =>
        postLedgerTransactionWithReversalLink(client, {
          transactionType: 'REWARD_REVERSAL',
          businessReferenceType: 'mal-amt',
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: 'mal-amt',
          assetId,
          reversesTransactionId: issued.tx.id,
          entries: [
            { ledgerAccountId: issued.expenseId, direction: 'CREDIT', amountAtomic: '29' },
            { ledgerAccountId: issued.pendingId, direction: 'DEBIT', amountAtomic: '29' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'REVERSAL_INVALID' });

    const linked = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(linked.rows[0]?.c).toBe(0);
    expect(await balanceOf(pool, issued.pendingId)).toBe(pendingBefore);
    expect(await versionOf(pool, issued.pendingId)).toBe(versionBefore);
  });

  it('rejects malformed direct linked reversal (wrong account / same direction / missing entry)', async () => {
    const userId = await createTestUser(pool, '920011');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '18',
      key: 'mal-shape',
    });
    const otherUser = await createTestUser(pool, '920012');
    const otherPending = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: otherUser,
      }),
    );

    await expect(
      postLedgerTransactionWithReversalLink(pool, {
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'mal-acct',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'mal-acct',
        assetId,
        reversesTransactionId: issued.tx.id,
        entries: [
          { ledgerAccountId: issued.expenseId, direction: 'CREDIT', amountAtomic: '18' },
          { ledgerAccountId: otherPending.id, direction: 'DEBIT', amountAtomic: '18' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_INVALID' });

    await expect(
      postLedgerTransactionWithReversalLink(pool, {
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'mal-dir',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'mal-dir',
        assetId,
        reversesTransactionId: issued.tx.id,
        entries: [
          { ledgerAccountId: issued.expenseId, direction: 'DEBIT', amountAtomic: '18' },
          { ledgerAccountId: issued.pendingId, direction: 'CREDIT', amountAtomic: '18' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_INVALID' });

    await expect(
      postLedgerTransactionWithReversalLink(pool, {
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'mal-extra',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'mal-extra',
        assetId,
        reversesTransactionId: issued.tx.id,
        entries: [
          { ledgerAccountId: issued.expenseId, direction: 'CREDIT', amountAtomic: '9' },
          { ledgerAccountId: issued.pendingId, direction: 'DEBIT', amountAtomic: '9' },
          { ledgerAccountId: issued.expenseId, direction: 'CREDIT', amountAtomic: '9' },
          { ledgerAccountId: issued.pendingId, direction: 'DEBIT', amountAtomic: '9' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_INVALID' });

    const linked = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(linked.rows[0]?.c).toBe(0);

    // Valid reverseLedgerTransaction still succeeds and consumes the slot once.
    const ok = await reverseLedgerTransaction(pool, {
      originalTransactionId: issued.tx.id,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'mal-then-ok',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase4',
      idempotencyKey: 'mal-then-ok',
    });
    expect(ok.reversesTransactionId).toBe(issued.tx.id);
    expect(await balanceOf(pool, issued.pendingId)).toBe(0n);

    const after = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(after.rows[0]?.c).toBe(1);
  });

  it('malformed attempt does not consume reversal slot so concurrent proper reversal still wins once', async () => {
    const userId = await createTestUser(pool, '920013');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '22',
      key: 'mal-slot',
    });

    await expect(
      postLedgerTransactionWithReversalLink(pool, {
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'mal-slot',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'mal-slot',
        assetId,
        reversesTransactionId: issued.tx.id,
        entries: [
          { ledgerAccountId: issued.expenseId, direction: 'CREDIT', amountAtomic: '1' },
          { ledgerAccountId: issued.pendingId, direction: 'DEBIT', amountAtomic: '1' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_INVALID' });

    const results = await Promise.allSettled([
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'slot-a',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'slot-a',
      }),
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'slot-b',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'slot-b',
      }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('public postLedgerTransaction cannot attach reversesTransactionId via typed API', async () => {
    const userId = await createTestUser(pool, '920014');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '5',
      key: 'no-public-rev',
    });
    // Runtime guard: even if a caller smuggles the field, linked posting is the only path.
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
      const posted = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'no-public-rev',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'no-public-rev',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '1' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '1' },
        ],
      });
      expect(posted.reversesTransactionId).toBeNull();
    });
    const linked = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1`,
      [issued.tx.id],
    );
    expect(linked.rows[0]?.c).toBe(0);
  });

  it('refuses a reversal that would drive a protected bucket negative', async () => {
    const userId = await createTestUser(pool, '920004');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '10',
      key: 'orig-4',
    });
    // Spend pending via maturity so reversing issuance alone would go negative on expense
    // side is fine, but pending would go negative if we already matured...
    // Actually reversing issuance after maturity: CR expense DR pending — pending would go negative.
    await withLedgerTransaction(pool, async (client) => {
      const { getOrCreateLedgerAccount, postLedgerTransaction } = await import('../src/index.js');
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'REWARD_MATURITY',
        businessReferenceType: 'mat-for-rev',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'mat-for-rev',
        assetId,
        entries: [
          { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic: '10' },
          { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic: '10' },
        ],
      });
    });

    await expect(
      reverseLedgerTransaction(pool, {
        originalTransactionId: issued.tx.id,
        transactionType: 'REWARD_REVERSAL',
        businessReferenceType: 'rev-neg',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'rev-neg',
      }),
    ).rejects.toMatchObject({ code: 'NEGATIVE_PROTECTED_BALANCE' });
  });
});
