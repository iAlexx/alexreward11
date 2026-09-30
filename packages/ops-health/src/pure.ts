/**
 * Pure helpers for Phase 18 health / alert evaluation.
 * No DB. No Ledger. No withdrawal mutations.
 */

import type { HealthState } from './types.js';

/** Missing authoritative signal must never become OK. */
export function stateFromMissingSignal(reasonCode = 'SIGNAL_NOT_CONFIGURED'): {
  readonly state: Extract<HealthState, 'UNKNOWN'>;
  readonly reasonCode: string;
} {
  return { state: 'UNKNOWN', reasonCode };
}

export function isFalseOkForbidden(state: HealthState, hadAuthoritativeSignal: boolean): boolean {
  if (!hadAuthoritativeSignal && state === 'OK') return true;
  return false;
}

/** Provider hard-limit utilization without inventing thresholds. */
export function classifyProviderLimitUtilization(input: {
  readonly used: number | null;
  readonly limit: number | null;
}): { readonly reasonCode: string; readonly severity: 'INFO' | 'DANGER' | 'OWNER_POLICY_REQUIRED' } {
  if (input.used === null || input.limit === null || input.limit <= 0) {
    return { reasonCode: 'THRESHOLD_NOT_CONFIGURED', severity: 'OWNER_POLICY_REQUIRED' };
  }
  // Exact exhaustion is observable from authoritative counters without inventing a "near" %.
  if (input.used >= input.limit) {
    return { reasonCode: 'LIMIT_EXHAUSTED', severity: 'DANGER' };
  }
  return { reasonCode: 'THRESHOLD_NOT_CONFIGURED', severity: 'OWNER_POLICY_REQUIRED' };
}

export function mapProviderHealthStatus(status: string | null | undefined): HealthState {
  if (status === null || status === undefined || status === '') return 'UNKNOWN';
  const normalized = status.toUpperCase();
  if (normalized === 'HEALTHY' || normalized === 'OK') return 'OK';
  if (normalized === 'DEGRADED') return 'DEGRADED';
  if (normalized === 'UNAVAILABLE' || normalized === 'DOWN' || normalized === 'SUSPENDED') {
    return 'UNAVAILABLE';
  }
  return 'UNKNOWN';
}

/** Bounded metric label keys only — never user/wallet/withdrawal IDs. */
export const ALLOWED_METRIC_LABEL_KEYS = [
  'component',
  'alert_class',
  'severity',
  'environment',
  'flag_key',
  'state',
] as const;

export function assertBoundedMetricLabels(
  labels: Readonly<Record<string, string>>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const key of Object.keys(labels)) {
    if (!(ALLOWED_METRIC_LABEL_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: `FORBIDDEN_LABEL:${key}` };
    }
  }
  return { ok: true };
}
