import type { PoolClient } from 'pg';

import { economicMultisetsEqual } from './intent.js';
import { LedgerDomainError } from './errors.js';
import type { CanonicalLedgerEntry, LedgerSide } from './types.js';

/**
 * Load original entries and verify proposed entries are an exact economic reversal
 * (same accounts/amounts; every DEBIT↔CREDIT swapped). Comparison is order-safe via multisets.
 */
export async function assertExactReversalOfOriginal(
  client: PoolClient,
  originalTransactionId: string,
  proposedAssetId: string,
  proposedEntries: ReadonlyArray<CanonicalLedgerEntry>,
): Promise<void> {
  const header = await client.query<{ id: string; asset_id: string }>(
    `SELECT id, asset_id FROM ledger_transactions WHERE id = $1`,
    [originalTransactionId],
  );
  const original = header.rows[0];
  if (original === undefined) {
    throw new LedgerDomainError('TRANSACTION_NOT_FOUND', 'Original transaction not found', {
      details: { originalTransactionId },
    });
  }
  if (original.asset_id !== proposedAssetId) {
    throw new LedgerDomainError('ASSET_MISMATCH', 'Reversal asset must match original', {
      details: { originalTransactionId, proposedAssetId },
    });
  }

  const entries = await client.query<{
    ledger_account_id: string;
    direction: LedgerSide;
    amount_atomic: string;
  }>(
    `SELECT ledger_account_id, direction, amount_atomic::text AS amount_atomic
     FROM ledger_entries
     WHERE ledger_transaction_id = $1`,
    [originalTransactionId],
  );
  if (entries.rows.length < 2) {
    throw new LedgerDomainError('REVERSAL_INVALID', 'Original transaction has no valid entry set', {
      details: { originalTransactionId },
    });
  }

  const expected = entries.rows.map((row) => ({
    ledgerAccountId: row.ledger_account_id,
    direction: row.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
    amountAtomic: BigInt(row.amount_atomic),
  }));
  const proposed = proposedEntries.map((entry) => ({
    ledgerAccountId: entry.ledgerAccountId,
    direction: entry.direction,
    amountAtomic: entry.amountAtomic,
  }));

  if (!economicMultisetsEqual(expected, proposed)) {
    throw new LedgerDomainError(
      'REVERSAL_INVALID',
      'Linked reversal entries must exactly swap the original economic entry set',
      { details: { originalTransactionId } },
    );
  }
}
