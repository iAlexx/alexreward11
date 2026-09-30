/**
 * Pure helpers for Phase 18 health / alert evaluation.
 * No DB. No Ledger. No withdrawal mutations.
 */

import type { AlertSeverity, HealthState } from './types.js';

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

/**
 * Effective UTC_DAY limit is the minimum max_count across currently applicable rules
 * (stricter-only composition). Caller must pre-filter ACTIVE + valid_from/valid_to.
 */
export function effectiveMinLimit(maxCounts: readonly number[]): number | null {
  const positive = maxCounts.filter((n) => Number.isFinite(n) && n >= 0);
  if (positive.length === 0) return null;
  return Math.min(...positive);
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

const HEALTH_RANK: Record<HealthState, number> = {
  OK: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  UNAVAILABLE: 3,
};

/** Fail-safe aggregate: worst observed state wins. Empty => UNKNOWN (never fabricate OK). */
export function aggregateHealthStates(states: readonly HealthState[]): HealthState {
  if (states.length === 0) return 'UNKNOWN';
  let worst: HealthState = 'OK';
  for (const state of states) {
    if (HEALTH_RANK[state] > HEALTH_RANK[worst]) worst = state;
  }
  return worst;
}

export function classifyUnresolvedReconciliation(input: {
  readonly criticalOpen: number;
  readonly warningOpen: number;
  readonly infoOpen: number;
}): {
  readonly state: HealthState;
  readonly severity: AlertSeverity;
  readonly reasonCode: string;
} {
  if (input.criticalOpen > 0) {
    return { state: 'DEGRADED', severity: 'DANGER', reasonCode: 'OPEN_CRITICAL_RECONCILIATION_ISSUES' };
  }
  if (input.warningOpen > 0) {
    return { state: 'DEGRADED', severity: 'WARN', reasonCode: 'OPEN_WARNING_RECONCILIATION_ISSUES' };
  }
  if (input.infoOpen > 0) {
    return { state: 'OK', severity: 'INFO', reasonCode: 'OPEN_INFO_RECONCILIATION_ISSUES' };
  }
  return { state: 'OK', severity: 'INFO', reasonCode: 'NO_UNRESOLVED_RECONCILIATION_ISSUES' };
}

/** Bounded metric label keys only — never user/wallet/withdrawal/provider IDs. */
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

/**
 * Strip comments from TypeScript/SQL-ish source so mutation scanners do not
 * false-positive on documentation that mentions forbidden verbs.
 */
export function stripCodeComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/(^|[\s;(])--[^\n]*/g, '$1');
}

/** Detect real SQL mutation verbs in executable (comment-stripped) source. */
export function containsSqlMutationStatement(source: string): boolean {
  const stripped = stripCodeComments(source);
  // Require mutation verb followed by typical SQL continuation to avoid English prose.
  return (
    /\bINSERT\s+INTO\b/i.test(stripped) ||
    /\bUPDATE\s+[A-Za-z_][\w.]*/i.test(stripped) ||
    /\bDELETE\s+FROM\b/i.test(stripped) ||
    /\bMERGE\s+INTO\b/i.test(stripped)
  );
}
