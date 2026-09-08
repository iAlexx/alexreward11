import type { PoolClient } from 'pg';

import { type LedgerDb, withLedgerTransaction } from './db.js';
import { LedgerDomainError } from './errors.js';
import { postLedgerTransaction } from './posting.js';
import type { LedgerSide, PostedLedgerTransaction, ReverseLedgerCommand } from './types.js';

async function loadOriginal(
  client: PoolClient,
  transactionId: string,
): Promise<{
  assetId: string;
  entries: Array<{
    ledgerAccountId: string;
    direction: LedgerSide;
    amountAtomic: string;
  }>;
}> {
  const header = await client.query<{ asset_id: string }>(
    `SELECT asset_id FROM ledger_transactions WHERE id = $1`,
    [transactionId],
  );
  if (header.rows[0] === undefined) {
    throw new LedgerDomainError('TRANSACTION_NOT_FOUND', 'Original transaction not found', {
      details: { transactionId },
    });
  }
  const entries = await client.query<{
    ledger_account_id: string;
    direction: LedgerSide;
    amount_atomic: string;
  }>(
    `SELECT ledger_account_id, direction, amount_atomic::text AS amount_atomic
     FROM ledger_entries
     WHERE ledger_transaction_id = $1
     ORDER BY entry_index ASC`,
    [transactionId],
  );
  if (entries.rows.length === 0) {
    throw new LedgerDomainError('VALIDATION', 'Original transaction has no entries');
  }
  return {
    assetId: header.rows[0].asset_id,
    entries: entries.rows.map((row) => ({
      ledgerAccountId: row.ledger_account_id,
      direction: row.direction,
      amountAtomic: row.amount_atomic,
    })),
  };
}

/**
 * Post a NEW linked reversal transaction. Never mutates the original header/entries.
 * At-most-one direct reversal is enforced by DB unique index + application check.
 */
export async function reverseLedgerTransaction(
  db: LedgerDb,
  command: ReverseLedgerCommand,
): Promise<PostedLedgerTransaction> {
  return withLedgerTransaction(db, async (client) => {
    const original = await loadOriginal(client, command.originalTransactionId);
    const swapped = original.entries.map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId,
      direction: entry.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      amountAtomic: entry.amountAtomic,
    }));

    const existing = await client.query<{
      id: string;
      idempotency_scope: string;
      idempotency_key: string;
    }>(
      `SELECT id, idempotency_scope, idempotency_key
       FROM ledger_transactions
       WHERE reverses_transaction_id = $1
       FOR UPDATE`,
      [command.originalTransactionId],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      if (
        existingRow.idempotency_scope === command.idempotencyScope &&
        existingRow.idempotency_key === command.idempotencyKey
      ) {
        return postLedgerTransaction(client, {
          transactionType: command.transactionType,
          businessReferenceType: command.businessReferenceType,
          businessReferenceId: command.businessReferenceId ?? null,
          idempotencyScope: command.idempotencyScope,
          idempotencyKey: command.idempotencyKey,
          assetId: original.assetId,
          reversesTransactionId: command.originalTransactionId,
          entries: swapped,
          ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
          ...(command.createdByType === undefined ? {} : { createdByType: command.createdByType }),
          createdById: command.createdById ?? null,
        });
      }
      throw new LedgerDomainError(
        'REVERSAL_CONFLICT',
        'Original transaction already has a direct reversal',
        { details: { existingReversalId: existingRow.id } },
      );
    }

    return postLedgerTransaction(client, {
      transactionType: command.transactionType,
      businessReferenceType: command.businessReferenceType,
      businessReferenceId: command.businessReferenceId ?? null,
      idempotencyScope: command.idempotencyScope,
      idempotencyKey: command.idempotencyKey,
      assetId: original.assetId,
      reversesTransactionId: command.originalTransactionId,
      entries: swapped,
      metadata: {
        ...(command.metadata ?? {}),
        reversalOf: command.originalTransactionId,
      },
      ...(command.createdByType === undefined ? {} : { createdByType: command.createdByType }),
      createdById: command.createdById ?? null,
    });
  });
}
