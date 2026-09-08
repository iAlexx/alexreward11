import type { PoolClient } from 'pg';

import { amountAtomicToString } from './amounts.js';
import { normalSideDelta } from './catalogue.js';
import type { LedgerDb } from './db.js';
import { isPool } from './db.js';
import type { LedgerSide } from './types.js';

export interface RebuiltAccountProjection {
  readonly ledgerAccountId: string;
  readonly balanceAtomic: string;
  readonly entryCount: number;
  readonly lastLedgerTransactionId: string | null;
}

export interface StoredAccountProjection {
  readonly ledgerAccountId: string;
  readonly balanceAtomic: string;
  readonly version: string;
  readonly lastLedgerTransactionId: string | null;
}

export interface ProjectionMismatch {
  readonly ledgerAccountId: string;
  readonly expectedBalanceAtomic: string;
  readonly storedBalanceAtomic: string;
  readonly expectedLastTransactionId: string | null;
  readonly storedLastTransactionId: string | null;
}

async function clientOf(db: LedgerDb): Promise<{ client: PoolClient; release: boolean }> {
  if (isPool(db)) {
    const client = await db.connect();
    return { client, release: true };
  }
  return { client: db, release: false };
}

/**
 * Independently rebuild balance projections from immutable ledger_entries.
 * Does not write. Does not trust ledger_account_balances.
 */
export async function rebuildAccountProjections(
  db: LedgerDb,
  options?: { readonly accountIds?: ReadonlyArray<string> },
): Promise<ReadonlyArray<RebuiltAccountProjection>> {
  const { client, release } = await clientOf(db);
  try {
    const params: unknown[] = [];
    let filter = '';
    if (options?.accountIds !== undefined && options.accountIds.length > 0) {
      params.push(options.accountIds);
      filter = `AND a.id = ANY($1::uuid[])`;
    }
    const result = await client.query<{
      ledger_account_id: string;
      normal_side: LedgerSide;
      entry_id: string | null;
      direction: LedgerSide | null;
      amount_atomic: string | null;
      ledger_transaction_id: string | null;
      posted_at: Date | null;
      entry_created_at: Date | null;
    }>(
      `SELECT a.id AS ledger_account_id,
              a.normal_side,
              e.id AS entry_id,
              e.direction,
              e.amount_atomic::text AS amount_atomic,
              e.ledger_transaction_id,
              t.posted_at,
              e.created_at AS entry_created_at
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id
       LEFT JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       WHERE 1=1 ${filter}
       ORDER BY a.id, t.posted_at NULLS LAST, e.entry_index NULLS LAST, e.id NULLS LAST`,
      params,
    );

    const byAccount = new Map<
      string,
      { balance: bigint; count: number; lastTx: string | null; normalSide: LedgerSide }
    >();

    for (const row of result.rows) {
      let state = byAccount.get(row.ledger_account_id);
      if (state === undefined) {
        state = { balance: 0n, count: 0, lastTx: null, normalSide: row.normal_side };
        byAccount.set(row.ledger_account_id, state);
      }
      if (row.entry_id === null || row.direction === null || row.amount_atomic === null) {
        continue;
      }
      state.balance += normalSideDelta(state.normalSide, row.direction, BigInt(row.amount_atomic));
      state.count += 1;
      state.lastTx = row.ledger_transaction_id;
    }

    return [...byAccount.entries()].map(([ledgerAccountId, state]) => ({
      ledgerAccountId,
      balanceAtomic: amountAtomicToString(state.balance),
      entryCount: state.count,
      lastLedgerTransactionId: state.lastTx,
    }));
  } finally {
    if (release) client.release();
  }
}

export async function loadStoredProjections(
  db: LedgerDb,
  options?: { readonly accountIds?: ReadonlyArray<string> },
): Promise<ReadonlyArray<StoredAccountProjection>> {
  const { client, release } = await clientOf(db);
  try {
    const params: unknown[] = [];
    let filter = '';
    if (options?.accountIds !== undefined && options.accountIds.length > 0) {
      params.push(options.accountIds);
      filter = `WHERE ledger_account_id = ANY($1::uuid[])`;
    }
    const result = await client.query<{
      ledger_account_id: string;
      balance_atomic: string;
      version: string;
      last_ledger_transaction_id: string | null;
    }>(
      `SELECT ledger_account_id,
              balance_atomic::text AS balance_atomic,
              version::text AS version,
              last_ledger_transaction_id
       FROM ledger_account_balances
       ${filter}
       ORDER BY ledger_account_id`,
      params,
    );
    return result.rows.map((row) => ({
      ledgerAccountId: row.ledger_account_id,
      balanceAtomic: row.balance_atomic,
      version: row.version,
      lastLedgerTransactionId: row.last_ledger_transaction_id,
    }));
  } finally {
    if (release) client.release();
  }
}

/**
 * Compare rebuilt projections to stored ledger_account_balances.
 * Never repairs. Mismatches are critical operational signals.
 */
export async function compareProjectionsToStored(
  db: LedgerDb,
  options?: { readonly accountIds?: ReadonlyArray<string> },
): Promise<{
  readonly ok: boolean;
  readonly mismatches: ReadonlyArray<ProjectionMismatch>;
}> {
  const rebuilt = await rebuildAccountProjections(db, options);
  const stored = await loadStoredProjections(db, options);
  const storedById = new Map(stored.map((row) => [row.ledgerAccountId, row]));
  const mismatches: ProjectionMismatch[] = [];

  for (const expected of rebuilt) {
    const actual = storedById.get(expected.ledgerAccountId);
    if (actual === undefined) {
      if (expected.entryCount === 0 && expected.balanceAtomic === '0') {
        continue;
      }
      mismatches.push({
        ledgerAccountId: expected.ledgerAccountId,
        expectedBalanceAtomic: expected.balanceAtomic,
        storedBalanceAtomic: '<missing>',
        expectedLastTransactionId: expected.lastLedgerTransactionId,
        storedLastTransactionId: null,
      });
      continue;
    }
    if (
      actual.balanceAtomic !== expected.balanceAtomic ||
      actual.lastLedgerTransactionId !== expected.lastLedgerTransactionId
    ) {
      mismatches.push({
        ledgerAccountId: expected.ledgerAccountId,
        expectedBalanceAtomic: expected.balanceAtomic,
        storedBalanceAtomic: actual.balanceAtomic,
        expectedLastTransactionId: expected.lastLedgerTransactionId,
        storedLastTransactionId: actual.lastLedgerTransactionId,
      });
    }
  }

  for (const actual of stored) {
    if (!rebuilt.some((row) => row.ledgerAccountId === actual.ledgerAccountId)) {
      if (actual.balanceAtomic !== '0') {
        mismatches.push({
          ledgerAccountId: actual.ledgerAccountId,
          expectedBalanceAtomic: '0',
          storedBalanceAtomic: actual.balanceAtomic,
          expectedLastTransactionId: null,
          storedLastTransactionId: actual.lastLedgerTransactionId,
        });
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
