/**
 * Withdrawal outbox relay scheduling.
 * When disabled, no interval is armed and no relay handler runs.
 * Confirmed public-payout consumer creates publications only (never Telegram).
 */
export interface WithdrawalOutboxRelayHandlers {
  readonly processApproved: () => Promise<unknown>;
  readonly processFailedPreRetry: () => Promise<unknown>;
  readonly processPhase21ManualDispatch: () => Promise<unknown>;
  readonly processConfirmedPublicPayout: () => Promise<unknown>;
}

export function createWithdrawalOutboxPoller(
  handlers: WithdrawalOutboxRelayHandlers,
): () => Promise<void> {
  return async () => {
    await handlers.processApproved();
    await handlers.processFailedPreRetry();
    await handlers.processPhase21ManualDispatch();
    await handlers.processConfirmedPublicPayout();
  };
}

export function startWithdrawalOutboxRelay(input: {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly poll: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
}): ReturnType<typeof setInterval> | undefined {
  if (!input.enabled) return undefined;
  let inFlight = false;
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
  }, input.intervalMs);
}
