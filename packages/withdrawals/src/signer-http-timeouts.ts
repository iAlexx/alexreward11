import { WithdrawalDomainError } from './errors.js';

/**
 * Bounded Signer HTTP deadlines for real-chain payout.
 * These are intentionally much shorter than attempt valid_until (300s) and
 * Temporal activity startToClose (300s) so a hung body read cannot consume
 * the full wallet-message validity window.
 */
export const SIGNER_HTTP_IDENTITY_TIMEOUT_MS = 15_000;
export const SIGNER_HTTP_SIGN_TIMEOUT_MS = 45_000;
/** Refuse to start/continue Signer I/O inside this margin of valid_until. */
export const SIGNER_HTTP_VALID_UNTIL_MARGIN_MS = 30_000;

export interface ResolveSignerHttpTimeoutInput {
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly validUntilMs?: number;
  readonly marginMs?: number;
}

/**
 * Cap a Signer HTTP operation so it always finishes with margin before valid_until.
 * Throws when the attempt is already too close to expiry to safely call Signer.
 */
export function resolveSignerHttpTimeoutMs(input: ResolveSignerHttpTimeoutInput): number {
  const marginMs = input.marginMs ?? SIGNER_HTTP_VALID_UNTIL_MARGIN_MS;
  let timeoutMs = input.timeoutMs;
  if (input.validUntilMs !== undefined) {
    const remaining = input.validUntilMs - marginMs - input.nowMs;
    if (remaining <= 0) {
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        'SIGNER_HTTP_REFUSED_EXPIRED_VALID_UNTIL',
        {
          details: {
            nowMs: input.nowMs,
            validUntilMs: input.validUntilMs,
            marginMs,
          },
        },
      );
    }
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  return Math.max(1, Math.floor(timeoutMs));
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return (error as { name?: string }).name === 'AbortError';
  }
  return false;
}

/**
 * Fetch + fully consume response text under a hard deadline.
 * Combines caller AbortSignal (activity cancellation) with a local timeout so
 * Temporal activity timeout alone cannot leave undici/fetch hanging forever.
 */
export async function fetchTextWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly response: Response; readonly text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const upstream = init.signal;
  const onUpstreamAbort = (): void => {
    controller.abort();
  };
  if (upstream !== undefined && upstream !== null) {
    if (upstream.aborted) {
      controller.abort();
    } else {
      upstream.addEventListener('abort', onUpstreamAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      const cancelledByUpstream = upstream?.aborted === true;
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        cancelledByUpstream
          ? 'SIGNER_HTTP_CANCELLED: activity cancellation aborted Signer HTTP I/O'
          : `SIGNER_HTTP_TIMEOUT: Signer HTTP exceeded ${timeoutMs}ms including response body`,
        {
          details: {
            timeoutMs,
            cancelledByUpstream,
          },
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (upstream !== undefined && upstream !== null) {
      upstream.removeEventListener('abort', onUpstreamAbort);
    }
  }
}
