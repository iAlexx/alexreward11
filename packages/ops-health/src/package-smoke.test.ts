import { describe, expect, it } from 'vitest';
import {
  ALERT_CLASSES,
  ALLOWED_METRIC_LABEL_KEYS,
  assertBoundedMetricLabels,
  classifyProviderLimitUtilization,
  isFalseOkForbidden,
  mapProviderHealthStatus,
  OPS_HEALTH_FORBIDDEN_MUTATIONS,
  stateFromMissingSignal,
  SYSTEM_COMPONENTS,
} from './index.js';

describe('ops-health pure contracts', () => {
  it('missing signal never becomes OK', () => {
    const missing = stateFromMissingSignal();
    expect(missing.state).toBe('UNKNOWN');
    expect(isFalseOkForbidden('OK', false)).toBe(true);
    expect(isFalseOkForbidden('UNKNOWN', false)).toBe(false);
  });

  it('maps provider health accurately', () => {
    expect(mapProviderHealthStatus('HEALTHY')).toBe('OK');
    expect(mapProviderHealthStatus('DEGRADED')).toBe('DEGRADED');
    expect(mapProviderHealthStatus('UNAVAILABLE')).toBe('UNAVAILABLE');
    expect(mapProviderHealthStatus(null)).toBe('UNKNOWN');
    expect(mapProviderHealthStatus('WEIRD')).toBe('UNKNOWN');
  });

  it('does not invent near-exhaustion thresholds', () => {
    expect(classifyProviderLimitUtilization({ used: 50, limit: 100 }).reasonCode).toBe(
      'THRESHOLD_NOT_CONFIGURED',
    );
    expect(classifyProviderLimitUtilization({ used: 100, limit: 100 }).reasonCode).toBe(
      'LIMIT_EXHAUSTED',
    );
    expect(classifyProviderLimitUtilization({ used: 100, limit: 100 }).severity).toBe('DANGER');
    expect(classifyProviderLimitUtilization({ used: null, limit: 100 }).severity).toBe(
      'OWNER_POLICY_REQUIRED',
    );
  });

  it('rejects high-cardinality metric labels', () => {
    expect(assertBoundedMetricLabels({ component: 'API', state: 'OK' }).ok).toBe(true);
    expect(assertBoundedMetricLabels({ user_id: 'u1' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ wallet_address: 'EQ...' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ withdrawal_id: 'w1' }).ok).toBe(false);
    expect(ALLOWED_METRIC_LABEL_KEYS).not.toContain('user_id');
  });

  it('forbids financial authority mutations', () => {
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.postLedgerEntry).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.mutateWithdrawal).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.overrideProviderHardLimit).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.overrideBudget).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.resolveReviewQueue).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.autoUnpausePayout).toBe(false);
  });

  it('exposes required system components and alert classes', () => {
    expect(SYSTEM_COMPONENTS).toContain('OUTBOX_LAG');
    expect(SYSTEM_COMPONENTS).toContain('SIGNER');
    expect(ALERT_CLASSES).toContain('REVIEW_QUEUE_BACKLOG');
    expect(ALERT_CLASSES).toContain('PAYOUT_DISPATCH_PAUSE');
  });
});
