/**
 * Idempotency keys for POST /v1/withdrawals.
 * One key per quote for the lifetime of that quote confirmation attempt.
 * Never regenerate on retry of the same quote.
 */
export type IdKeyGenerator = () => string;

export function createQuoteIdempotencyStore(generate: IdKeyGenerator = () => {
  return globalThis.crypto.randomUUID();
}) {
  const keys = new Map<string, string>();

  return {
    getOrCreate(quoteId: string): string {
      const existing = keys.get(quoteId);
      if (existing !== undefined) return existing;
      const next = generate();
      keys.set(quoteId, next);
      return next;
    },
    peek(quoteId: string): string | undefined {
      return keys.get(quoteId);
    },
    clear(quoteId: string): void {
      keys.delete(quoteId);
    },
    clearAll(): void {
      keys.clear();
    },
  };
}

export type QuoteIdempotencyStore = ReturnType<typeof createQuoteIdempotencyStore>;
