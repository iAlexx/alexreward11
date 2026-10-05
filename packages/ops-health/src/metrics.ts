/**
 * Phase 18 Step 1 — bounded-cardinality OTEL metrics for ops health.
 */

import { metrics } from '@alex-rewards/observability';
import { assertBoundedMetricLabels } from './pure.js';
import type { OpsHealthSnapshot } from './types.js';

const METER_NAME = 'alex-rewards.ops-health';

export function recordOpsHealthMetrics(snapshot: OpsHealthSnapshot): void {
  const meter = metrics.getMeter(METER_NAME);

  const componentState = meter.createGauge('ops_health.component_state', {
    description: 'Component health state encoded: OK=0 DEGRADED=1 UNAVAILABLE=2 UNKNOWN=3',
  });
  const alertCount = meter.createGauge('ops_health.alert_count', {
    description: 'Count of alert observations by class and severity',
  });
  const payoutPause = meter.createGauge('ops_health.payout_dispatch_pause', {
    description: 'PAYOUT_DISPATCH_PAUSE enabled=1 disabled=0 unknown=-1',
  });

  const stateCode = (state: string): number => {
    if (state === 'OK') return 0;
    if (state === 'DEGRADED') return 1;
    if (state === 'UNAVAILABLE') return 2;
    return 3;
  };

  for (const c of snapshot.components) {
    const labels = { component: c.component, state: c.state };
    const check = assertBoundedMetricLabels(labels);
    if (!check.ok) continue;
    componentState.record(stateCode(c.state), labels);
  }

  const byClass = new Map<string, number>();
  for (const a of snapshot.alerts) {
    const key = `${a.alertClass}|${a.severity}`;
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byClass) {
    const [alertClass, severity] = key.split('|');
    const labels = { alert_class: alertClass!, severity: severity! };
    const check = assertBoundedMetricLabels(labels);
    if (!check.ok) continue;
    alertCount.record(count, labels);
  }

  const pauseLabels = {
    flag_key: 'PAYOUT_DISPATCH_PAUSE',
    environment: snapshot.payoutDispatchPause.environment,
  };
  const pauseCheck = assertBoundedMetricLabels(pauseLabels);
  if (pauseCheck.ok) {
    const value =
      snapshot.payoutDispatchPause.enabled === true
        ? 1
        : snapshot.payoutDispatchPause.enabled === false
          ? 0
          : -1;
    payoutPause.record(value, pauseLabels);
  }
}
