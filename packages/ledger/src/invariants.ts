import type { PoolClient } from 'pg';

import { isProtectedUserBucket } from './catalogue.js';
import type { LedgerDb } from './db.js';
import { isPool } from './db.js';
import { compareProjectionsToStored } from './projection.js';
import type { LedgerAccountType, LedgerSide } from './types.js';

export type InvariantSeverity = 'CRITICAL' | 'OK';

export interface InvariantFinding {
  readonly code: string;
  readonly severity: InvariantSeverity;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface InvariantCheckResult {
  readonly ok: boolean;
  readonly findings: ReadonlyArray<InvariantFinding>;
}

async function clientOf(db: LedgerDb): Promise<{ client: PoolClient; release: boolean }> {
  if (isPool(db)) {
    const client = await db.connect();
    return { client, release: true };
  }
  return { client: db, release: false };
}

function critical(
  findings: InvariantFinding[],
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  findings.push({
    code,
    severity: 'CRITICAL',
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * Read-only financial invariant checker. Never mutates ledger history.
 */
export async function checkLedgerInvariants(db: LedgerDb): Promise<InvariantCheckResult> {
  const findings: InvariantFinding[] = [];
  const { client, release } = await clientOf(db);
  try {
    // Debit == credit per transaction
    const unbalanced = await client.query<{
      ledger_transaction_id: string;
      debit_total: string;
      credit_total: string;
    }>(
      `SELECT ledger_transaction_id,
              COALESCE(SUM(amount_atomic) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debit_total,
              COALESCE(SUM(amount_atomic) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credit_total
       FROM ledger_entries
       GROUP BY ledger_transaction_id
       HAVING COALESCE(SUM(amount_atomic) FILTER (WHERE direction = 'DEBIT'), 0)
            <> COALESCE(SUM(amount_atomic) FILTER (WHERE direction = 'CREDIT'), 0)`,
    );
    for (const row of unbalanced.rows) {
      critical(findings, 'UNBALANCED_TRANSACTION', 'Transaction debits do not equal credits', {
        transactionId: row.ledger_transaction_id,
        debitTotal: row.debit_total,
        creditTotal: row.credit_total,
      });
    }

    // Amount > 0 (defense in depth beyond CHECK)
    const badAmounts = await client.query<{ id: string; amount_atomic: string }>(
      `SELECT id, amount_atomic::text AS amount_atomic
       FROM ledger_entries WHERE amount_atomic <= 0`,
    );
    for (const row of badAmounts.rows) {
      critical(findings, 'NON_POSITIVE_ENTRY', 'Ledger entry amount must be > 0', {
        entryId: row.id,
        amountAtomic: row.amount_atomic,
      });
    }

    // Entry account asset matches transaction asset; one asset per tx (by header)
    const assetMismatch = await client.query<{
      entry_id: string;
      transaction_id: string;
    }>(
      `SELECT e.id AS entry_id, t.id AS transaction_id
       FROM ledger_entries e
       INNER JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE a.asset_id <> t.asset_id`,
    );
    for (const row of assetMismatch.rows) {
      critical(
        findings,
        'ENTRY_ASSET_MISMATCH',
        'Entry account asset differs from transaction asset',
        {
          entryId: row.entry_id,
          transactionId: row.transaction_id,
        },
      );
    }

    // Orphan entries / broken FKs (should be impossible with FK, still check)
    const orphanEntries = await client.query<{ id: string }>(
      `SELECT e.id
       FROM ledger_entries e
       LEFT JOIN ledger_transactions t ON t.id = e.ledger_transaction_id
       LEFT JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE t.id IS NULL OR a.id IS NULL`,
    );
    for (const row of orphanEntries.rows) {
      critical(findings, 'ORPHAN_ENTRY', 'Ledger entry references missing account or transaction', {
        entryId: row.id,
      });
    }

    // Protected buckets non-negative
    const protectedBalances = await client.query<{
      ledger_account_id: string;
      account_type: LedgerAccountType;
      balance_atomic: string;
    }>(
      `SELECT b.ledger_account_id, a.account_type, b.balance_atomic::text AS balance_atomic
       FROM ledger_account_balances b
       INNER JOIN ledger_accounts a ON a.id = b.ledger_account_id
       WHERE a.account_type IN (
         'USER_PENDING_LIABILITY', 'USER_AVAILABLE_LIABILITY', 'USER_RESERVED_LIABILITY'
       )
         AND b.balance_atomic < 0`,
    );
    for (const row of protectedBalances.rows) {
      if (isProtectedUserBucket(row.account_type)) {
        critical(findings, 'NEGATIVE_PROTECTED_BALANCE', 'Protected user bucket is negative', {
          accountId: row.ledger_account_id,
          accountType: row.account_type,
          balanceAtomic: row.balance_atomic,
        });
      }
    }

    // Projection rebuild comparison
    const comparison = await compareProjectionsToStored(client);
    for (const mismatch of comparison.mismatches) {
      critical(findings, 'PROJECTION_MISMATCH', 'Stored projection differs from rebuilt entries', {
        ...mismatch,
      });
    }

    // Projection version / last pointer sanity where checkable
    const badVersion = await client.query<{ ledger_account_id: string; version: string }>(
      `SELECT ledger_account_id, version::text AS version
       FROM ledger_account_balances WHERE version < 0`,
    );
    for (const row of badVersion.rows) {
      critical(findings, 'INVALID_PROJECTION_VERSION', 'Projection version must be >= 0', {
        accountId: row.ledger_account_id,
        version: row.version,
      });
    }

    // At most one direct reversal (index should enforce; detect anyway)
    const multiReversal = await client.query<{ reverses_transaction_id: string; c: string }>(
      `SELECT reverses_transaction_id, count(*)::text AS c
       FROM ledger_transactions
       WHERE reverses_transaction_id IS NOT NULL
       GROUP BY reverses_transaction_id
       HAVING count(*) > 1`,
    );
    for (const row of multiReversal.rows) {
      critical(findings, 'MULTIPLE_REVERSALS', 'Original has more than one direct reversal', {
        originalTransactionId: row.reverses_transaction_id,
        count: row.c,
      });
    }

    // Reversal asset / amounts consistency
    const reversals = await client.query<{
      reversal_id: string;
      original_id: string;
      reversal_asset: string;
      original_asset: string;
    }>(
      `SELECT r.id AS reversal_id, o.id AS original_id,
              r.asset_id AS reversal_asset, o.asset_id AS original_asset
       FROM ledger_transactions r
       INNER JOIN ledger_transactions o ON o.id = r.reverses_transaction_id`,
    );
    for (const row of reversals.rows) {
      if (row.reversal_asset !== row.original_asset) {
        critical(findings, 'REVERSAL_ASSET_MISMATCH', 'Reversal asset differs from original', {
          reversalId: row.reversal_id,
          originalId: row.original_id,
        });
      }
      const originalEntries = await client.query<{
        direction: LedgerSide;
        amount_atomic: string;
        entry_index: number;
        ledger_account_id: string;
      }>(
        `SELECT direction, amount_atomic::text AS amount_atomic, entry_index, ledger_account_id
         FROM ledger_entries WHERE ledger_transaction_id = $1 ORDER BY entry_index`,
        [row.original_id],
      );
      const reversalEntries = await client.query<{
        direction: LedgerSide;
        amount_atomic: string;
        entry_index: number;
        ledger_account_id: string;
      }>(
        `SELECT direction, amount_atomic::text AS amount_atomic, entry_index, ledger_account_id
         FROM ledger_entries WHERE ledger_transaction_id = $1 ORDER BY entry_index`,
        [row.reversal_id],
      );
      if (originalEntries.rows.length !== reversalEntries.rows.length) {
        critical(findings, 'REVERSAL_ENTRY_COUNT', 'Reversal entry count differs from original', {
          reversalId: row.reversal_id,
        });
        continue;
      }
      for (let i = 0; i < originalEntries.rows.length; i += 1) {
        const o = originalEntries.rows[i];
        const r = reversalEntries.rows[i];
        if (o === undefined || r === undefined) continue;
        const expectedDirection = o.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
        if (
          r.ledger_account_id !== o.ledger_account_id ||
          r.amount_atomic !== o.amount_atomic ||
          r.direction !== expectedDirection
        ) {
          critical(findings, 'REVERSAL_ENTRY_MISMATCH', 'Reversal entries do not swap original', {
            reversalId: row.reversal_id,
            entryIndex: i,
          });
        }
      }
    }

    // No users.balance shortcut
    const usersBalance = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'balance'
       ) AS exists`,
    );
    if (usersBalance.rows[0]?.exists === true) {
      critical(findings, 'USERS_BALANCE_SHORTCUT', 'Forbidden users.balance column exists');
    }
  } finally {
    if (release) client.release();
  }

  return { ok: findings.every((item) => item.severity !== 'CRITICAL'), findings };
}
