/**
 * Public payout delivery poller (bot-owned Telegram transport).
 * Mirrors Owner Review poller: interval + in-process in-flight guard.
 */
export const PUBLIC_PAYOUT_POLL_INTERVAL_MS = 2_000;

export function startPublicPayoutDeliveryPoller(input: {
  readonly enabled: boolean;
  readonly intervalMs?: number;
  readonly poll: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
}): ReturnType<typeof setInterval> | undefined {
  if (!input.enabled) return undefined;
  let inFlight = false;
  const intervalMs = input.intervalMs ?? PUBLIC_PAYOUT_POLL_INTERVAL_MS;
  const schedule = input.schedule ?? setInterval;
  return schedule(() => {
    if (inFlight) return;
    inFlight = true;
    void input
      .poll()
      .catch((error: unknown) => {
        input.onError(error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
}
