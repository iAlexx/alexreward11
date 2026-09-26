/**
 * Mirror Mini App `formatAtomicAmount` — canonical integer decimal string, no grouping.
 */
export function formatAtomicForUi(amountAtomic: string): string {
  return BigInt(amountAtomic).toString();
}
