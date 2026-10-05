/**
 * Phase 18 Step 1 — System / business health types.
 * Observations only. Never financial authority.
 */

export const HEALTH_STATES = ['OK', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const SYSTEM_COMPONENTS = [
  'API',
  'POSTGRES',
  'REDIS',
  'TEMPORAL',
  'TELEGRAM_BOT',
  'ADS_PROVIDER',
  'TON_RPC_PRIMARY',
  'TON_RPC_SECONDARY',
  'SIGNER',
  'HOT_WALLET_CHAIN_SYNC',
  'OUTBOX_LAG',
  'RECONCILIATION',
] as const;
export type SystemComponentId = (typeof SYSTEM_COMPONENTS)[number];

export const ALERT_CLASSES = [
  'OUTBOX_LAG',
  'RECONCILIATION_MISMATCH',
  'PROVIDER_HEALTH',
  'PROVIDER_LIMIT',
  'PROVIDER_SETTLEMENT',
  'REWARD_BUDGET_EXPOSURE',
  'FOUNDER_BONUS_BUDGET_EXPOSURE',
  'REVIEW_QUEUE_BACKLOG',
  'HOT_WALLET_COVERAGE',
  'SIGNER_NOT_READY',
  'PAYOUT_DISPATCH_PAUSE',
] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];

export type AlertSeverity = 'INFO' | 'WARN' | 'DANGER' | 'OWNER_POLICY_REQUIRED';

export interface HealthComponentSnapshot {
  readonly component: SystemComponentId;
  readonly state: HealthState;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface BusinessAlertObservation {
  readonly alertClass: AlertClass;
  readonly severity: AlertSeverity;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Explicit: alert evaluation never mutates domain financial state.
   */
  readonly financialAuthority: false;
  readonly mutatesLedger: false;
  readonly mutatesWithdrawals: false;
  readonly autoUnpause: false;
}

export interface PayoutDispatchPauseSnapshot {
  readonly flagKey: 'PAYOUT_DISPATCH_PAUSE';
  readonly environment: string;
  readonly enabled: boolean | null;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly authoritativeSource: 'feature_flags';
  readonly autoUnpause: false;
}

export interface OpsHealthSnapshot {
  readonly contractVersion: 'phase18-ops-health-v1';
  readonly observedAt: string;
  readonly components: readonly HealthComponentSnapshot[];
  readonly alerts: readonly BusinessAlertObservation[];
  readonly payoutDispatchPause: PayoutDispatchPauseSnapshot;
  readonly financialAuthority: false;
}
