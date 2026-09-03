export const HEALTH_CONTRACT_VERSION = '1' as const;

export type HealthState = 'ok' | 'degraded' | 'unavailable';

export interface HealthComponent {
  readonly name: string;
  readonly state: HealthState;
  readonly latencyMs?: number;
}

export interface HealthResponse {
  readonly contractVersion: typeof HEALTH_CONTRACT_VERSION;
  readonly service: string;
  readonly status: HealthState;
  readonly timestamp: string;
  readonly components?: readonly HealthComponent[];
}
