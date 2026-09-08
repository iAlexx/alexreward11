import { createHash } from 'node:crypto';

import type { CanonicalLedgerEntry, LedgerTransactionType } from './types.js';

export interface LedgerIntent {
  readonly transactionType: LedgerTransactionType;
  readonly businessReferenceType: string;
  readonly businessReferenceId: string | null;
  readonly assetId: string;
  readonly reversesTransactionId: string | null;
  readonly entries: ReadonlyArray<CanonicalLedgerEntry>;
}

/** Deterministic fingerprint of immutable financial intent for idempotency comparison. */
export function ledgerIntentFingerprint(intent: LedgerIntent): string {
  const normalizedEntries = [...intent.entries]
    .map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId,
      direction: entry.direction,
      amountAtomic: entry.amountAtomic.toString(10),
      entryIndex: entry.entryIndex,
    }))
    .sort((a, b) => {
      if (a.entryIndex !== b.entryIndex) return a.entryIndex - b.entryIndex;
      if (a.ledgerAccountId !== b.ledgerAccountId) {
        return a.ledgerAccountId < b.ledgerAccountId ? -1 : 1;
      }
      if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
      return a.amountAtomic < b.amountAtomic ? -1 : a.amountAtomic > b.amountAtomic ? 1 : 0;
    });

  const payload = JSON.stringify({
    transactionType: intent.transactionType,
    businessReferenceType: intent.businessReferenceType,
    businessReferenceId: intent.businessReferenceId,
    assetId: intent.assetId,
    reversesTransactionId: intent.reversesTransactionId,
    entries: normalizedEntries,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function intentsMatch(a: LedgerIntent, b: LedgerIntent): boolean {
  return ledgerIntentFingerprint(a) === ledgerIntentFingerprint(b);
}
