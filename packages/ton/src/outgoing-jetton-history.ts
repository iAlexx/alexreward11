/**
 * Shared helpers for provider-neutral outgoing Jetton history enumeration.
 */

export const ENUMERATE_HISTORY_MAX_PAGES = 100;
export const ENUMERATE_HISTORY_DEFAULT_PAGE_SIZE = 100;

export function isoToUnixSeconds(iso: string, context: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`MALFORMED_INPUT: ${context} is not a valid ISO timestamp`);
  }
  return Math.floor(ms / 1000);
}

export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return ENUMERATE_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('MALFORMED_INPUT: pageSize must be a positive integer');
  }
  return Math.min(pageSize, ENUMERATE_HISTORY_DEFAULT_PAGE_SIZE);
}

/** Prefer nonzero query_id; otherwise compose a stable synthetic identity. */
export function buildTransferIdentity(input: {
  readonly queryId: string | null;
  readonly transactionHash: string | null;
  readonly transactionLt: string | null;
  readonly amountAtomic: string;
  readonly recipient: string;
}): string {
  if (input.queryId !== null && input.queryId !== '' && input.queryId !== '0') {
    return String(input.queryId);
  }
  return `${input.transactionHash ?? ''}|${input.transactionLt ?? ''}|${input.amountAtomic}|${input.recipient}`;
}

export function trackObservedBounds(
  current: { oldest: number | null; newest: number | null },
  utimeSeconds: number,
): void {
  if (!Number.isFinite(utimeSeconds)) return;
  if (current.oldest === null || utimeSeconds < current.oldest) current.oldest = utimeSeconds;
  if (current.newest === null || utimeSeconds > current.newest) current.newest = utimeSeconds;
}

export function finalizeWindowCoverage(input: {
  readonly truncatedBySafety: boolean;
  readonly cursorExhausted: boolean;
  readonly oldestObservedUnix: number | null;
  readonly windowStartUnix: number;
}): { readonly windowFullyCovered: boolean; readonly truncated: boolean } {
  // Covered when the cursor is exhausted, or pagination reached an observation
  // strictly older than windowStart. Page-cap / stuck-cursor force incomplete.
  const reachedPastWindowStart =
    input.oldestObservedUnix !== null && input.oldestObservedUnix < input.windowStartUnix;
  const windowFullyCovered =
    !input.truncatedBySafety && (input.cursorExhausted || reachedPastWindowStart);
  const truncated = input.truncatedBySafety || !windowFullyCovered;
  return { windowFullyCovered, truncated };
}

export function timestampInInclusiveWindow(
  utimeSeconds: number,
  windowStartUnix: number,
  windowEndUnix: number,
): boolean {
  return utimeSeconds >= windowStartUnix && utimeSeconds <= windowEndUnix;
}
