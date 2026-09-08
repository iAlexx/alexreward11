import type { PoolClient } from 'pg';

import { amountAtomicToString } from './amounts.js';
import { normalSideDelta } from './catalogue.js';
import type { LedgerDb } from './db.js';
import { isPool } from './db.js';
import type { LedgerSide } from './types.js';

export interface RebuiltAccountProjection {
  readonly ledgerAccountId: string;
  /** Balance rebuilt exactly from immutable entries. */
  readonly balanceAtomic: string;
  readonly entryCount: number;
  /**
   * Number of DISTINCT posted ledger transactions that affected this account.
   * One multi-line transaction counts once.
   */
  readonly expectedVersion: string;
  /**
   * Candidate last-transaction ids at the latest posted_at for this account.
   * Same-timestamp ties are all acceptable; UUID order is not financial chronology.
   */
  readonly latestPostedAtCandidates: ReadonlyArray<string>;
  /** Convenience: null when no history; otherwise one candidate (not a total order). */
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
  readonly expectedVersion?: string;
  readonly storedVersion?: string;
  readonly expectedLastTransactionCandidates?: ReadonlyArray<string>;
  readonly storedLastTransactionId: string | null;
  readonly reason?: string;
}

async function clientOf(db: LedgerDb): Promise<{ client: PoolClient; release: boolean }> {
  if (isPool(db)) {
    const client = await db.connect();
    return { client, release: true };
  }
  return { client: db, release: false };
}

/**
 * Independently rebuild balance + version projections from immutable ledger_entries.
 * Does not write. Does not trust ledger_account_balances.
 *
 * Semantics (Option 1 — no schema migration):
 * - balance_atomic: exact sum of entry deltas using account normal_side
 * - version: count of DISTINCT ledger_transaction_id touching the account
 * - last_ledger_transaction_id: not reconstructed as a total order when posted_at ties;
 *   rebuild returns the set of transaction ids at max(posted_at) for the account
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
    }>(
      `SELECT a.id AS ledger_account_id,
              a.normal_side,
              e.id AS entry_id,
              e.direction,
              e.amount_atomic::text AS amount_atomic,
              e.ledger_transaction_id,
              t.posted_at
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id
       LEFT JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       WHERE 1=1 ${filter}
       ORDER BY a.id, t.posted_at NULLS LAST, e.entry_index NULLS LAST, e.id NULLS LAST`,
      params,
    );

    const byAccount = new Map<
      string,
      {
        balance: bigint;
        count: number;
        normalSide: LedgerSide;
        txIds: Set<string>;
        maxPostedAtMs: number | null;
        candidates: Set<string>;
      }
    >();

    for (const row of result.rows) {
      let state = byAccount.get(row.ledger_account_id);
      if (state === undefined) {
        state = {
          balance: 0n,
          count: 0,
          normalSide: row.normal_side,
          txIds: new Set(),
          maxPostedAtMs: null,
          candidates: new Set(),
        };
        byAccount.set(row.ledger_account_id, state);
      }
      if (
        row.entry_id === null ||
        row.direction === null ||
        row.amount_atomic === null ||
        row.ledger_transaction_id === null ||
        row.posted_at === null
      ) {
        continue;
      }
      state.balance += normalSideDelta(state.normalSide, row.direction, BigInt(row.amount_atomic));
      state.count += 1;
      state.txIds.add(row.ledger_transaction_id);

      const postedMs = row.posted_at.getTime();
      if (state.maxPostedAtMs === null || postedMs > state.maxPostedAtMs) {
        state.maxPostedAtMs = postedMs;
        state.candidates = new Set([row.ledger_transaction_id]);
      } else if (postedMs === state.maxPostedAtMs) {
        state.candidates.add(row.ledger_transaction_id);
      }
    }

    return [...byAccount.entries()].map(([ledgerAccountId, state]) => {
      const candidates = [...state.candidates].sort();
      return {
        ledgerAccountId,
        balanceAtomic: amountAtomicToString(state.balance),
        entryCount: state.count,
        expectedVersion: state.txIds.size.toString(10),
        latestPostedAtCandidates: candidates,
        lastLedgerTransactionId: candidates.length === 0 ? null : (candidates[0] ?? null),
      };
    });
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

function lastPointerAcceptable(
  expected: RebuiltAccountProjection,
  storedLast: string | null,
): { ok: boolean; reason?: string } {
  if (expected.entryCount === 0) {
    if (storedLast !== null) {
      return {
        ok: false,
        reason: 'zero-history account must have null last_ledger_transaction_id',
      };
    }
    return { ok: true };
  }
  if (storedLast === null) {
    return {
      ok: false,
      reason: 'account with history must have non-null last_ledger_transaction_id',
    };
  }
  if (!expected.latestPostedAtCandidates.includes(storedLast)) {
    return {
      ok: false,
      reason:
        'last_ledger_transaction_id is not among transactions at the latest posted_at for this account',
    };
  }
  return { ok: true };
}

/**
 * Compare rebuilt projections to stored ledger_account_balances.
 * Never repairs. Mismatches are critical operational signals.
 *
 * last_ledger_transaction_id validation is tie-aware: any transaction id in the
 * latest posted_at cohort that touched the account is acceptable. UUID order is not used.
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
        expectedVersion: expected.expectedVersion,
        storedLastTransactionId: null,
        expectedLastTransactionCandidates: expected.latestPostedAtCandidates,
        reason: 'missing projection row',
      });
      continue;
    }

    const reasons: string[] = [];
    if (actual.balanceAtomic !== expected.balanceAtomic) {
      reasons.push('balance mismatch');
    }
    if (actual.version !== expected.expectedVersion) {
      reasons.push('version mismatch');
    }
    const lastCheck = lastPointerAcceptable(expected, actual.lastLedgerTransactionId);
    if (!lastCheck.ok && lastCheck.reason !== undefined) {
      reasons.push(lastCheck.reason);
    }

    if (reasons.length > 0) {
      mismatches.push({
        ledgerAccountId: expected.ledgerAccountId,
        expectedBalanceAtomic: expected.balanceAtomic,
        storedBalanceAtomic: actual.balanceAtomic,
        expectedVersion: expected.expectedVersion,
        storedVersion: actual.version,
        expectedLastTransactionCandidates: expected.latestPostedAtCandidates,
        storedLastTransactionId: actual.lastLedgerTransactionId,
        reason: reasons.join('; '),
      });
    }
  }

  for (const actual of stored) {
    if (!rebuilt.some((row) => row.ledgerAccountId === actual.ledgerAccountId)) {
      if (
        actual.balanceAtomic !== '0' ||
        actual.version !== '0' ||
        actual.lastLedgerTransactionId !== null
      ) {
        mismatches.push({
          ledgerAccountId: actual.ledgerAccountId,
          expectedBalanceAtomic: '0',
          storedBalanceAtomic: actual.balanceAtomic,
          expectedVersion: '0',
          storedVersion: actual.version,
          storedLastTransactionId: actual.lastLedgerTransactionId,
          reason: 'orphan projection without account history context',
        });
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}
