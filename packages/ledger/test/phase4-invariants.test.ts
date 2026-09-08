import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  checkLedgerInvariants,
  compareProjectionsToStored,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  rebuildAccountProjections,
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

describe.skipIf(phase4DatabaseUrl === '')('Phase 4 ledger invariants + projection rebuild', () => {
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

  it('rebuilds projections matching stored balances after many postings and a reversal', async () => {
    const userId = await createTestUser(pool, '930001');
    for (let i = 0; i < 5; i += 1) {
      await issuePendingReward({
        pool,
        userId,
        assetId,
        amount: String(10 + i),
        key: `many-${i}`,
      });
    }
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '5',
      key: 'to-reverse',
    });
    await reverseLedgerTransaction(pool, {
      originalTransactionId: issued.tx.id,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'inv-rev',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase4',
      idempotencyKey: 'inv-rev',
    });

    const comparison = await compareProjectionsToStored(pool);
    expect(comparison.ok).toBe(true);
    expect(comparison.mismatches).toEqual([]);

    const rebuilt = await rebuildAccountProjections(pool);
    expect(rebuilt.length).toBeGreaterThan(0);

    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(true);
  });

  it('detects deliberate projection tampering and never silently repairs', async () => {
    const userId = await createTestUser(pool, '930002');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '44',
      key: 'tamper-1',
    });
    await pool.query(
      `UPDATE ledger_account_balances SET balance_atomic = 999 WHERE ledger_account_id = $1`,
      [issued.pendingId],
    );
    const comparison = await compareProjectionsToStored(pool, { accountIds: [issued.pendingId] });
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches[0]?.storedBalanceAtomic).toBe('999');
    expect(comparison.mismatches[0]?.expectedBalanceAtomic).toBe('44');

    const after = await pool.query<{ balance_atomic: string }>(
      `SELECT balance_atomic::text AS balance_atomic FROM ledger_account_balances WHERE ledger_account_id = $1`,
      [issued.pendingId],
    );
    expect(after.rows[0]?.balance_atomic).toBe('999');

    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(false);
    expect(invariants.findings.some((item) => item.code === 'PROJECTION_MISMATCH')).toBe(true);
  });

  it('rejects UPDATE/DELETE on posted transactions and entries', async () => {
    const userId = await createTestUser(pool, '930003');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '3',
      key: 'immut-1',
    });
    await expect(
      pool.query(`UPDATE ledger_transactions SET metadata = '{}'::jsonb WHERE id = $1`, [
        issued.tx.id,
      ]),
    ).rejects.toThrow(/append-only|rejected|restrict/i);
    await expect(
      pool.query(`DELETE FROM ledger_transactions WHERE id = $1`, [issued.tx.id]),
    ).rejects.toThrow(/append-only|rejected|restrict/i);
    await expect(
      pool.query(`UPDATE ledger_entries SET amount_atomic = 1 WHERE ledger_transaction_id = $1`, [
        issued.tx.id,
      ]),
    ).rejects.toThrow(/append-only|rejected|restrict/i);
    await expect(
      pool.query(`DELETE FROM ledger_entries WHERE ledger_transaction_id = $1`, [issued.tx.id]),
    ).rejects.toThrow(/append-only|rejected|restrict/i);
  });

  it('rejects structural mutation of ledger_accounts', async () => {
    const account = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      }),
    );
    await expect(
      pool.query(`UPDATE ledger_accounts SET account_class = 'ASSET' WHERE id = $1`, [account.id]),
    ).rejects.toThrow(/structural|immutable|restrict/i);
    // status lifecycle remains allowed
    await expect(
      pool.query(`UPDATE ledger_accounts SET status = 'DISABLED' WHERE id = $1`, [account.id]),
    ).resolves.toBeTruthy();
  });

  it('detects unbalanced fixture state without editing ledger history', async () => {
    // Disable immutability triggers briefly in a controlled local session to insert
    // a malformed fixture, then re-enable and run the checker.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await client.query('ALTER TABLE ledger_transactions DISABLE TRIGGER USER');
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const userId = await createTestUser(
        // use pool for user insert outside? createTestUser uses pool - use client SQL
        pool,
        '930004',
      );
      // createTestUser used pool outside this txn — ok for fixture user
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const tx = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (
           transaction_type, business_reference_type, business_reference_id,
           idempotency_scope, idempotency_key, asset_id
         ) VALUES ('MANUAL_CORRECTION', 'malformed', $1, 'phase4', 'malformed-1', $2)
         RETURNING id`,
        [randomUUID(), assetId],
      );
      const txId = tx.rows[0]?.id;
      if (txId === undefined) throw new Error('tx insert failed');
      await client.query(
        `INSERT INTO ledger_entries (ledger_transaction_id, ledger_account_id, direction, amount_atomic, entry_index)
         VALUES ($1, $2, 'DEBIT', 10, 0), ($1, $3, 'CREDIT', 7, 1)`,
        [txId, expense.id, pending.id],
      );
      await client.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await client.query('ALTER TABLE ledger_transactions ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const beforeEntries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(false);
    expect(invariants.findings.some((item) => item.code === 'UNBALANCED_TRANSACTION')).toBe(true);
    const afterEntries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    expect(afterEntries.rows[0]?.c).toBe(beforeEntries.rows[0]?.c);
  });

  it('confirms no users.balance column exists', async () => {
    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.findings.some((item) => item.code === 'USERS_BALANCE_SHORTCUT')).toBe(false);
  });

  it('same outer transaction multi-post rebuild and invariants pass (2 and 3 posts)', async () => {
    const userId = await createTestUser(pool, '930010');
    const two = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const a = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'same-txn-a',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'same-txn-a',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '10' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '10' },
        ],
      });
      const b = await postLedgerTransaction(client, {
        transactionType: 'REWARD_ISSUANCE',
        businessReferenceType: 'same-txn-b',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase4',
        idempotencyKey: 'same-txn-b',
        assetId,
        entries: [
          { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: '7' },
          { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: '7' },
        ],
      });
      return { pendingId: pending.id, a, b };
    });

    expect(await balanceOf(pool, two.pendingId)).toBe(17n);
    expect(await versionOf(pool, two.pendingId)).toBe(2n);
    const comparisonTwo = await compareProjectionsToStored(pool, {
      accountIds: [two.pendingId],
    });
    expect(comparisonTwo.ok).toBe(true);
    expect((await checkLedgerInvariants(pool)).ok).toBe(true);

    const userId3 = await createTestUser(pool, '930011');
    const three = await withLedgerTransaction(pool, async (client) => {
      const expense = await getOrCreateLedgerAccount(client, {
        accountType: 'PLATFORM_REWARD_EXPENSE',
        assetId,
      });
      const pending = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_PENDING_LIABILITY',
        assetId,
        ownerId: userId3,
      });
      for (const [key, amount] of [
        ['t1', '1'],
        ['t2', '2'],
        ['t3', '3'],
      ] as const) {
        await postLedgerTransaction(client, {
          transactionType: 'REWARD_ISSUANCE',
          businessReferenceType: `same-txn3-${key}`,
          businessReferenceId: randomUUID(),
          idempotencyScope: 'phase4',
          idempotencyKey: `same-txn3-${key}`,
          assetId,
          entries: [
            { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: amount },
            { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: amount },
          ],
        });
      }
      return pending.id;
    });
    expect(await balanceOf(pool, three)).toBe(6n);
    expect(await versionOf(pool, three)).toBe(3n);
    expect((await compareProjectionsToStored(pool, { accountIds: [three] })).ok).toBe(true);
    expect((await checkLedgerInvariants(pool)).ok).toBe(true);
  });

  it('detects stored version tampering and unrelated last pointer', async () => {
    const userId = await createTestUser(pool, '930012');
    const issued = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '11',
      key: 'ver-tamper',
    });
    await pool.query(
      `UPDATE ledger_account_balances SET version = 99 WHERE ledger_account_id = $1`,
      [issued.pendingId],
    );
    let invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(false);
    expect(invariants.findings.some((item) => item.code === 'PROJECTION_MISMATCH')).toBe(true);

    // Restore version, plant unrelated last pointer (other account's tx).
    await pool.query(
      `UPDATE ledger_account_balances SET version = 1 WHERE ledger_account_id = $1`,
      [issued.pendingId],
    );
    const other = await issuePendingReward({
      pool,
      userId,
      assetId,
      amount: '2',
      key: 'other-tx',
    });
    // Point pending at expense-only? Use a fresh account with no shared history:
    // set last pointer of a zero-history sibling account to issued.tx
    const zero = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    await pool.query(
      `UPDATE ledger_account_balances
       SET last_ledger_transaction_id = $2
       WHERE ledger_account_id = $1`,
      [zero.id, other.tx.id],
    );
    invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(false);
    expect(
      invariants.findings.some(
        (item) =>
          item.code === 'LAST_POINTER_UNRELATED' || item.code === 'ZERO_HISTORY_INCONSISTENT',
      ),
    ).toBe(true);
  });

  it('zero-history account metadata is internally consistent and checker is read-only', async () => {
    const userId = await createTestUser(pool, '930013');
    const account = await withLedgerTransaction(pool, (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    const before = await pool.query(
      `SELECT balance_atomic::text AS balance_atomic, version::text AS version, last_ledger_transaction_id
       FROM ledger_account_balances WHERE ledger_account_id = $1`,
      [account.id],
    );
    expect(before.rows[0]).toMatchObject({
      balance_atomic: '0',
      version: '0',
      last_ledger_transaction_id: null,
    });
    const entryCountBefore = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(true);
    const entryCountAfter = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    expect(entryCountAfter.rows[0]?.c).toBe(entryCountBefore.rows[0]?.c);
    const after = await pool.query(
      `SELECT balance_atomic::text AS balance_atomic, version::text AS version, last_ledger_transaction_id
       FROM ledger_account_balances WHERE ledger_account_id = $1`,
      [account.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('detects ledger transactions with fewer than two entries', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
      await client.query('ALTER TABLE ledger_transactions DISABLE TRIGGER USER');
      const tx = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (
           transaction_type, business_reference_type, business_reference_id,
           idempotency_scope, idempotency_key, asset_id
         ) VALUES ('MANUAL_CORRECTION', 'thin', $1, 'phase4', 'thin-1', $2)
         RETURNING id`,
        [randomUUID(), assetId],
      );
      const txId = tx.rows[0]?.id;
      if (txId === undefined) throw new Error('tx insert failed');
      // zero entries
      await client.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
      await client.query('ALTER TABLE ledger_transactions ENABLE TRIGGER USER');
      await client.query('COMMIT');
      void txId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const invariants = await checkLedgerInvariants(pool);
    expect(invariants.ok).toBe(false);
    expect(invariants.findings.some((item) => item.code === 'INSUFFICIENT_ENTRIES')).toBe(true);
  });
});
