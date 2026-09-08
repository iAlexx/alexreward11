import { createHash } from 'node:crypto';

import type { CanonicalLedgerEntry, LedgerSide, LedgerTransactionType } from './types.js';

export interface LedgerIntent {
  readonly transactionType: LedgerTransactionType;
  readonly businessReferenceType: string;
  readonly businessReferenceId: string | null;
  readonly assetId: string;
  readonly reversesTransactionId: string | null;
  readonly entries: ReadonlyArray<CanonicalLedgerEntry>;
}

export interface EconomicEntry {
  readonly ledgerAccountId: string;
  readonly direction: LedgerSide;
  readonly amountAtomic: bigint;
}

function entryEconomicKey(entry: EconomicEntry): string {
  return `${entry.ledgerAccountId}|${entry.direction}|${entry.amountAtomic.toString(10)}`;
}

/** Order-independent multiset of economic entries (account, direction, amount). */
export function economicEntryMultiset(entries: ReadonlyArray<EconomicEntry>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entryEconomicKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function economicMultisetsEqual(
  a: ReadonlyArray<EconomicEntry>,
  b: ReadonlyArray<EconomicEntry>,
): boolean {
  const left = economicEntryMultiset(a);
  const right = economicEntryMultiset(b);
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/**
 * Deterministic fingerprint of immutable financial intent.
 * Entry caller order / entryIndex are NOT part of financial identity — only the
 * economic multiset (account, direction, amount) matters.
 */
export function ledgerIntentFingerprint(intent: LedgerIntent): string {
  const normalizedEntries = [...intent.entries]
    .map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId,
      direction: entry.direction,
      amountAtomic: entry.amountAtomic.toString(10),
    }))
    .sort((a, b) => {
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
