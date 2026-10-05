import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';

/**
 * Worker health. Intentional outbox-relay disablement stays `ok`.
 * Readiness follows Temporal worker startup, not the relay flag.
 */
export function buildWorkerHealth(input: {
  readonly ready: boolean;
  readonly outboxRelayEnabled: boolean;
  readonly timestamp: string;
}): HealthResponse {
  const status = input.ready ? 'ok' : 'unavailable';
  return {
    contractVersion: HEALTH_CONTRACT_VERSION,
    service: 'worker',
    status,
    timestamp: input.timestamp,
    components: [
      { name: 'temporal-worker', state: status },
      {
        name: input.outboxRelayEnabled
          ? 'withdrawal-outbox-relay:enabled'
          : 'withdrawal-outbox-relay:disabled',
        state: 'ok',
      },
    ],
  };
}
