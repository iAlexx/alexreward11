/**
 * Phase 18 Step 1 — ops-health evaluation invariants.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertBoundedMetricLabels,
  evaluateOpsHealth,
  isFalseOkForbidden,
  mapProviderHealthStatus,
  OPS_HEALTH_FORBIDDEN_MUTATIONS,
  stateFromMissingSignal,
} from '../src/index.js';

type QueryResult = { rowCount: number; rows: unknown[] };

function createFakePool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
  } as unknown as import('pg').Pool;
}

describe('ops-health evaluate — missing signals', () => {
  it('missing health signal => UNKNOWN, never false OK', async () => {
    expect(stateFromMissingSignal().state).toBe('UNKNOWN');
    expect(isFalseOkForbidden('OK', false)).toBe(true);

    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) return { rowCount: 0, rows: [] };
      if (sql.includes('outbox_events')) return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      if (sql.includes('review_cases') && sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('provider_health_snapshots')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '0' }] };
      }
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({
      pool,
      environment: 'LOCAL',
      // No probes → POSTGRES/REDIS/TEMPORAL must be UNKNOWN, never OK
      probes: { apiOk: true },
    });

    const postgres = snapshot.components.find((c) => c.component === 'POSTGRES');
    const redis = snapshot.components.find((c) => c.component === 'REDIS');
    const temporal = snapshot.components.find((c) => c.component === 'TEMPORAL');
    const signer = snapshot.components.find((c) => c.component === 'SIGNER');
    const tonPrimary = snapshot.components.find((c) => c.component === 'TON_RPC_PRIMARY');

    expect(postgres?.state).toBe('UNKNOWN');
    expect(redis?.state).toBe('UNKNOWN');
    expect(temporal?.state).toBe('UNKNOWN');
    expect(signer?.state).toBe('UNKNOWN');
    expect(tonPrimary?.state).toBe('UNKNOWN');
    expect(snapshot.financialAuthority).toBe(false);
  });

  it('degraded provider is represented accurately', async () => {
    expect(mapProviderHealthStatus('DEGRADED')).toBe('DEGRADED');

    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('provider_health_snapshots')) {
        return { rowCount: 1, rows: [{ status: 'DEGRADED' }] };
      }
      if (sql.includes('provider_limit_rules')) {
        return { rowCount: 1, rows: [{ max_count: 100 }] };
      }
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '1' }] };
      }
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '2' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({
      pool,
      environment: 'LOCAL',
      probes: { apiOk: true, postgresOk: true, redisOk: true, temporalOk: true },
    });

    const ads = snapshot.components.find((c) => c.component === 'ADS_PROVIDER');
    expect(ads?.state).toBe('DEGRADED');
    const providerAlert = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_HEALTH');
    expect(providerAlert?.severity).toBe('WARN');
  });

  it('reconciliation mismatch raises health/alert condition', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '3' }] };
      }
      if (sql.includes('provider_health_snapshots')) {
        return { rowCount: 1, rows: [{ status: 'HEALTHY' }] };
      }
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '0' }] };
      }
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '3' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'STAGING' });
    const recon = snapshot.components.find((c) => c.component === 'RECONCILIATION');
    expect(recon?.state).toBe('DEGRADED');
    const alert = snapshot.alerts.find((a) => a.alertClass === 'RECONCILIATION_MISMATCH');
    expect(alert?.severity).toBe('DANGER');
    expect(alert?.reasonCode).toBe('OPEN_RECONCILIATION_CASES');
  });

  it('Review Queue backlog reads authoritative review_cases only', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('provider_health_snapshots')) {
        return { rowCount: 1, rows: [{ status: 'HEALTHY' }] };
      }
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '0' }] };
      }
      if (sql.includes('FROM review_cases') && sql.includes('open_count')) {
        return { rowCount: 1, rows: [{ open_count: '5' }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const backlog = snapshot.alerts.find((a) => a.alertClass === 'REVIEW_QUEUE_BACKLOG');
    expect(backlog?.detailsRedacted?.sourceTable).toBe('review_cases');
    expect(backlog?.detailsRedacted?.openCount).toBe(5);
    expect(backlog?.reasonCode).toBe('THRESHOLD_NOT_CONFIGURED');
  });
});

describe('ops-health — no financial authority', () => {
  it('alerts cannot mutate ledger / withdrawals / limits / budgets / auto-unpause', () => {
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.postLedgerEntry).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.mutateWithdrawal).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.overrideProviderHardLimit).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.overrideBudget).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.resolveReviewQueue).toBe(false);
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.autoUnpausePayout).toBe(false);
  });

  it('every alert observation declares no financial authority', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '1', oldest_age_seconds: '90' }] };
      }
      if (sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('provider_health_snapshots')) {
        return { rowCount: 1, rows: [{ status: 'HEALTHY' }] };
      }
      if (sql.includes('provider_limit_rules')) {
        return { rowCount: 1, rows: [{ max_count: 10 }] };
      }
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '1' }] };
      }
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    for (const alert of snapshot.alerts) {
      expect(alert.financialAuthority).toBe(false);
      expect(alert.mutatesLedger).toBe(false);
      expect(alert.mutatesWithdrawals).toBe(false);
      expect(alert.autoUnpause).toBe(false);
    }
    expect(snapshot.payoutDispatchPause.autoUnpause).toBe(false);
    expect(snapshot.payoutDispatchPause.authoritativeSource).toBe('feature_flags');
    expect(snapshot.payoutDispatchPause.enabled).toBe(true);
  });

  it('metric labels remain bounded', () => {
    expect(assertBoundedMetricLabels({ component: 'API', state: 'OK' }).ok).toBe(true);
    expect(assertBoundedMetricLabels({ user_id: 'x' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ wallet_address: 'EQ' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ withdrawal_id: 'w' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ tx_hash: 'h' }).ok).toBe(false);
  });

  it('provider limit near-exhaustion does not invent thresholds', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: false }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('RECONCILIATION_ISSUE')) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('provider_health_snapshots')) {
        return { rowCount: 1, rows: [{ status: 'HEALTHY' }] };
      }
      if (sql.includes('provider_limit_rules')) {
        return { rowCount: 1, rows: [{ max_count: 100 }] };
      }
      if (sql.includes('reward_budget_periods') || sql.includes('membership_bonus_budget_periods')) {
        return { rowCount: 1, rows: [{ exhausted: '0', active: '1' }] };
      }
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const limitAlert = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_LIMIT');
    expect(limitAlert?.reasonCode).toBe('THRESHOLD_NOT_CONFIGURED');
    expect(limitAlert?.severity).toBe('OWNER_POLICY_REQUIRED');

    const rewardAlert = snapshot.alerts.find((a) => a.alertClass === 'REWARD_BUDGET_EXPOSURE');
    expect(rewardAlert?.reasonCode).toBe('THRESHOLD_NOT_CONFIGURED');
  });
});
