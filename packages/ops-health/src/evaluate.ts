/**
 * Phase 18 Step 1 — read-only system/business health evaluation.
 * NEVER posts ledger, mutates withdrawals, overrides limits/budgets, or auto-unpauses.
 */

import type { Pool } from 'pg';
import {
  classifyProviderLimitUtilization,
  mapProviderHealthStatus,
  stateFromMissingSignal,
} from './pure.js';
import type {
  BusinessAlertObservation,
  HealthComponentSnapshot,
  OpsHealthSnapshot,
  PayoutDispatchPauseSnapshot,
  SystemComponentId,
} from './types.js';
import { SYSTEM_COMPONENTS } from './types.js';

export interface OpsHealthEvaluateInput {
  readonly pool: Pool;
  readonly environment: string;
  readonly now?: Date;
  /** Optional pre-probed dependency signals from the API process. */
  readonly probes?: {
    readonly postgresOk?: boolean;
    readonly redisOk?: boolean | null;
    readonly redisConfigured?: boolean;
    readonly temporalOk?: boolean | null;
    readonly temporalConfigured?: boolean;
    readonly apiOk?: boolean;
  };
}

function iso(d: Date): string {
  return d.toISOString();
}

function alertBase(
  alertClass: BusinessAlertObservation['alertClass'],
  severity: BusinessAlertObservation['severity'],
  reasonCode: string,
  observedAt: string,
  detailsRedacted?: BusinessAlertObservation['detailsRedacted'],
): BusinessAlertObservation {
  return {
    alertClass,
    severity,
    reasonCode,
    observedAt,
    financialAuthority: false,
    mutatesLedger: false,
    mutatesWithdrawals: false,
    autoUnpause: false,
    ...(detailsRedacted === undefined ? {} : { detailsRedacted }),
  };
}

function component(
  id: SystemComponentId,
  state: HealthComponentSnapshot['state'],
  reasonCode: string,
  observedAt: string,
  detailsRedacted?: HealthComponentSnapshot['detailsRedacted'],
): HealthComponentSnapshot {
  return {
    component: id,
    state,
    reasonCode,
    observedAt,
    ...(detailsRedacted === undefined ? {} : { detailsRedacted }),
  };
}

async function readPayoutPause(
  pool: Pool,
  environment: string,
  observedAt: string,
): Promise<PayoutDispatchPauseSnapshot> {
  const result = await pool.query<{ enabled: boolean }>(
    `SELECT enabled
       FROM feature_flags
      WHERE environment = $1::environment_name
        AND flag_key = 'PAYOUT_DISPATCH_PAUSE'
      LIMIT 1`,
    [environment],
  );
  if (result.rowCount === 0) {
    return {
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment,
      enabled: null,
      reasonCode: 'FLAG_NOT_CONFIGURED',
      observedAt,
      authoritativeSource: 'feature_flags',
      autoUnpause: false,
    };
  }
  return {
    flagKey: 'PAYOUT_DISPATCH_PAUSE',
    environment,
    enabled: Boolean(result.rows[0]?.enabled),
    reasonCode: result.rows[0]?.enabled ? 'PAUSED' : 'NOT_PAUSED',
    observedAt,
    authoritativeSource: 'feature_flags',
    autoUnpause: false,
  };
}

async function readOutboxLag(
  pool: Pool,
  observedAt: string,
): Promise<{ component: HealthComponentSnapshot; alert: BusinessAlertObservation }> {
  try {
    const result = await pool.query<{ pending: string; oldest_age_seconds: string | null }>(
      `SELECT
         COUNT(*)::text AS pending,
         COALESCE(
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::bigint,
           0
         )::text AS oldest_age_seconds
       FROM outbox_events
      WHERE status = 'PENDING'`,
    );
    const pending = Number(result.rows[0]?.pending ?? 0);
    const oldestAgeSeconds = Number(result.rows[0]?.oldest_age_seconds ?? 0);
    // Pending count is authoritative; lag severity threshold is Owner policy.
    const alert =
      pending > 0
        ? alertBase('OUTBOX_LAG', 'OWNER_POLICY_REQUIRED', 'THRESHOLD_NOT_CONFIGURED', observedAt, {
            pending,
            oldestAgeSeconds,
          })
        : alertBase('OUTBOX_LAG', 'INFO', 'NO_PENDING', observedAt, {
            pending: 0,
            oldestAgeSeconds: 0,
          });
    return {
      component: component('OUTBOX_LAG', 'OK', 'OUTBOX_OBSERVED', observedAt, {
        pending,
        oldestAgeSeconds,
      }),
      alert,
    };
  } catch {
    const missing = stateFromMissingSignal('OUTBOX_QUERY_FAILED');
    return {
      component: component('OUTBOX_LAG', missing.state, missing.reasonCode, observedAt),
      alert: alertBase('OUTBOX_LAG', 'WARN', 'OUTBOX_QUERY_FAILED', observedAt),
    };
  }
}

async function readReconciliation(
  pool: Pool,
  observedAt: string,
): Promise<{ component: HealthComponentSnapshot; alert: BusinessAlertObservation }> {
  try {
    // Persisted mismatch table is absent; open RECONCILIATION_ISSUE review cases are the
    // operational projection. Phase 10 CLI restore-reconcile remains a separate scanner.
    const counts = await pool.query<{ open_count: string }>(
      `SELECT COUNT(*)::text AS open_count
         FROM review_cases
        WHERE case_type = 'RECONCILIATION_ISSUE'
          AND state = ANY(ARRAY['OPEN','IN_REVIEW','WAITING_INPUT','ESCALATED']::review_case_state[])`,
    );
    const openCount = Number(counts.rows[0]?.open_count ?? 0);
    if (openCount > 0) {
      return {
        component: component('RECONCILIATION', 'DEGRADED', 'OPEN_RECONCILIATION_CASES', observedAt, {
          openCount,
        }),
        alert: alertBase('RECONCILIATION_MISMATCH', 'DANGER', 'OPEN_RECONCILIATION_CASES', observedAt, {
          openCount,
        }),
      };
    }
    return {
      component: component('RECONCILIATION', 'OK', 'NO_OPEN_RECONCILIATION_CASES', observedAt, {
        openCount: 0,
      }),
      alert: alertBase('RECONCILIATION_MISMATCH', 'INFO', 'NO_OPEN_RECONCILIATION_CASES', observedAt, {
        openCount: 0,
      }),
    };
  } catch {
    const missing = stateFromMissingSignal('RECONCILIATION_QUERY_FAILED');
    return {
      component: component('RECONCILIATION', missing.state, missing.reasonCode, observedAt),
      alert: alertBase('RECONCILIATION_MISMATCH', 'WARN', 'RECONCILIATION_QUERY_FAILED', observedAt),
    };
  }
}

async function readProviderHealth(
  pool: Pool,
  observedAt: string,
): Promise<{ component: HealthComponentSnapshot; alerts: BusinessAlertObservation[] }> {
  const alerts: BusinessAlertObservation[] = [];
  try {
    const latest = await pool.query<{ status: string }>(
      `SELECT status::text AS status
         FROM provider_health_snapshots
        ORDER BY observed_at DESC, created_at DESC, id DESC
        LIMIT 1`,
    );
    if (latest.rowCount === 0) {
      // Ads package rule: missing observation fails closed as UNAVAILABLE.
      alerts.push(alertBase('PROVIDER_HEALTH', 'DANGER', 'NO_PROVIDER_OBSERVATION', observedAt));
      return {
        component: component('ADS_PROVIDER', 'UNAVAILABLE', 'NO_PROVIDER_OBSERVATION', observedAt),
        alerts,
      };
    }
    const status = latest.rows[0]?.status ?? null;
    const state = mapProviderHealthStatus(status);
    alerts.push(
      alertBase(
        'PROVIDER_HEALTH',
        state === 'OK' ? 'INFO' : state === 'DEGRADED' ? 'WARN' : 'DANGER',
        state === 'OK' ? 'PROVIDER_HEALTHY' : `PROVIDER_${state}`,
        observedAt,
        { status: status ?? 'null' },
      ),
    );
    return {
      component: component('ADS_PROVIDER', state, `PROVIDER_${state}`, observedAt, {
        status: status ?? 'null',
      }),
      alerts,
    };
  } catch {
    const missing = stateFromMissingSignal('PROVIDER_HEALTH_QUERY_FAILED');
    alerts.push(alertBase('PROVIDER_HEALTH', 'WARN', 'PROVIDER_HEALTH_QUERY_FAILED', observedAt));
    return {
      component: component('ADS_PROVIDER', missing.state, missing.reasonCode, observedAt),
      alerts,
    };
  }
}

async function readProviderLimits(
  pool: Pool,
  observedAt: string,
): Promise<BusinessAlertObservation[]> {
  try {
    const rows = await pool.query<{ max_count: number }>(
      `SELECT max_count
         FROM provider_limit_rules
        WHERE status = 'ACTIVE'
        LIMIT 50`,
    );
    if (rows.rowCount === 0) {
      return [alertBase('PROVIDER_LIMIT', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt)];
    }
    // Authoritative hard limits exist; near-exhaustion % is Owner policy.
    // Exact exhaustion requires paired usage counters — without approved utilization
    // threshold or joined usage projection, do not invent near/exhausted.
    let anyZero = 0;
    for (const row of rows.rows) {
      const classified = classifyProviderLimitUtilization({
        used: null,
        limit: row.max_count,
      });
      if (classified.reasonCode === 'THRESHOLD_NOT_CONFIGURED') anyZero += 1;
    }
    return [
      alertBase('PROVIDER_LIMIT', 'OWNER_POLICY_REQUIRED', 'THRESHOLD_NOT_CONFIGURED', observedAt, {
        activeRulesObserved: rows.rowCount ?? 0,
        nearExhaustionPolicyRequired: anyZero,
      }),
    ];
  } catch {
    return [alertBase('PROVIDER_LIMIT', 'WARN', 'PROVIDER_LIMIT_QUERY_FAILED', observedAt)];
  }
}

async function readSettlement(
  _pool: Pool,
  observedAt: string,
): Promise<BusinessAlertObservation> {
  // No dedicated provider_settlement_mismatches table in schema yet.
  return alertBase('PROVIDER_SETTLEMENT', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt);
}

async function readBudgetExposure(
  pool: Pool,
  observedAt: string,
  alertClass: 'REWARD_BUDGET_EXPOSURE' | 'FOUNDER_BONUS_BUDGET_EXPOSURE',
  tableName: 'reward_budget_periods' | 'membership_bonus_budget_periods',
): Promise<BusinessAlertObservation> {
  try {
    const sql =
      tableName === 'reward_budget_periods'
        ? `SELECT
             COUNT(*) FILTER (
               WHERE reserved_atomic + consumed_atomic >= budget_atomic
             )::text AS exhausted,
             COUNT(*)::text AS active
           FROM reward_budget_periods
          WHERE status = 'ACTIVE'
            AND period_start <= NOW()
            AND period_end > NOW()`
        : `SELECT
             COUNT(*) FILTER (
               WHERE reserved_atomic + consumed_atomic >= budget_atomic
             )::text AS exhausted,
             COUNT(*)::text AS active
           FROM membership_bonus_budget_periods
          WHERE status = 'ACTIVE'
            AND period_start <= NOW()
            AND period_end > NOW()`;
    const rows = await pool.query<{
      exhausted: string;
      active: string;
    }>(sql);
    const exhausted = Number(rows.rows[0]?.exhausted ?? 0);
    const active = Number(rows.rows[0]?.active ?? 0);
    if (active === 0) {
      return alertBase(alertClass, 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt, {
        table: tableName,
      });
    }
    if (exhausted > 0) {
      return alertBase(alertClass, 'DANGER', 'BUDGET_EXHAUSTED', observedAt, {
        table: tableName,
        exhaustedCount: exhausted,
        activeCount: active,
      });
    }
    // Near-exhaustion % requires Owner policy — do not invent.
    return alertBase(alertClass, 'OWNER_POLICY_REQUIRED', 'THRESHOLD_NOT_CONFIGURED', observedAt, {
      table: tableName,
      activeCount: active,
      exhaustedCount: 0,
    });
  } catch {
    return alertBase(alertClass, 'WARN', 'BUDGET_QUERY_FAILED', observedAt, { table: tableName });
  }
}

async function readReviewQueueBacklog(
  pool: Pool,
  observedAt: string,
): Promise<BusinessAlertObservation> {
  try {
    const counts = await pool.query<{ open_count: string }>(
      `SELECT COUNT(*)::text AS open_count
         FROM review_cases
        WHERE state = ANY(ARRAY['OPEN','IN_REVIEW','WAITING_INPUT','ESCALATED']::review_case_state[])`,
    );
    const openCount = Number(counts.rows[0]?.open_count ?? 0);
    return alertBase(
      'REVIEW_QUEUE_BACKLOG',
      openCount > 0 ? 'OWNER_POLICY_REQUIRED' : 'INFO',
      openCount > 0 ? 'THRESHOLD_NOT_CONFIGURED' : 'NO_OPEN_CASES',
      observedAt,
      { openCount, sourceTable: 'review_cases' },
    );
  } catch {
    return alertBase('REVIEW_QUEUE_BACKLOG', 'WARN', 'REVIEW_QUEUE_QUERY_FAILED', observedAt);
  }
}

function probeComponent(
  id: SystemComponentId,
  probes: OpsHealthEvaluateInput['probes'],
  observedAt: string,
): HealthComponentSnapshot {
  if (id === 'API') {
    const ok = probes?.apiOk !== false;
    return component(id, ok ? 'OK' : 'UNAVAILABLE', ok ? 'API_PROCESS_UP' : 'API_PROCESS_DOWN', observedAt);
  }
  if (id === 'POSTGRES') {
    if (probes?.postgresOk === true) return component(id, 'OK', 'POSTGRES_REACHABLE', observedAt);
    if (probes?.postgresOk === false) return component(id, 'UNAVAILABLE', 'POSTGRES_UNREACHABLE', observedAt);
    return component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt);
  }
  if (id === 'REDIS') {
    if (probes?.redisConfigured === false) return component(id, 'UNKNOWN', 'NOT_CONFIGURED', observedAt);
    if (probes?.redisOk === true) return component(id, 'OK', 'REDIS_REACHABLE', observedAt);
    if (probes?.redisOk === false) return component(id, 'UNAVAILABLE', 'REDIS_UNREACHABLE', observedAt);
    return component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt);
  }
  if (id === 'TEMPORAL') {
    if (probes?.temporalConfigured === false) return component(id, 'UNKNOWN', 'NOT_CONFIGURED', observedAt);
    if (probes?.temporalOk === true) return component(id, 'OK', 'TEMPORAL_REACHABLE', observedAt);
    if (probes?.temporalOk === false) return component(id, 'UNAVAILABLE', 'TEMPORAL_UNREACHABLE', observedAt);
    return component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt);
  }
  return component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt);
}

/**
 * Evaluate a full ops-health snapshot. Read-only.
 * Does not write to ledger, withdrawals, feature_flags, budgets, or provider limits.
 */
export async function evaluateOpsHealth(input: OpsHealthEvaluateInput): Promise<OpsHealthSnapshot> {
  const now = input.now ?? new Date();
  const observedAt = iso(now);
  const components: HealthComponentSnapshot[] = [];
  const alerts: BusinessAlertObservation[] = [];

  for (const id of SYSTEM_COMPONENTS) {
    if (id === 'API' || id === 'POSTGRES' || id === 'REDIS' || id === 'TEMPORAL') {
      components.push(probeComponent(id, input.probes, observedAt));
      continue;
    }
    if (id === 'OUTBOX_LAG') {
      const outbox = await readOutboxLag(input.pool, observedAt);
      components.push(outbox.component);
      alerts.push(outbox.alert);
      continue;
    }
    if (id === 'RECONCILIATION') {
      const recon = await readReconciliation(input.pool, observedAt);
      components.push(recon.component);
      alerts.push(recon.alert);
      continue;
    }
    if (id === 'ADS_PROVIDER') {
      const provider = await readProviderHealth(input.pool, observedAt);
      components.push(provider.component);
      alerts.push(...provider.alerts);
      continue;
    }
    // TELEGRAM_BOT, TON_RPC_*, SIGNER, HOT_WALLET — no false OK without signal
    components.push(component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt));
  }

  alerts.push(...(await readProviderLimits(input.pool, observedAt)));
  alerts.push(await readSettlement(input.pool, observedAt));
  alerts.push(
    await readBudgetExposure(input.pool, observedAt, 'REWARD_BUDGET_EXPOSURE', 'reward_budget_periods'),
  );
  alerts.push(
    await readBudgetExposure(
      input.pool,
      observedAt,
      'FOUNDER_BONUS_BUDGET_EXPOSURE',
      'membership_bonus_budget_periods',
    ),
  );
  alerts.push(await readReviewQueueBacklog(input.pool, observedAt));

  alerts.push(alertBase('SIGNER_NOT_READY', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt));
  alerts.push(alertBase('HOT_WALLET_COVERAGE', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt));

  const payoutDispatchPause = await readPayoutPause(input.pool, input.environment, observedAt);
  alerts.push(
    alertBase('PAYOUT_DISPATCH_PAUSE', 'INFO', payoutDispatchPause.reasonCode, observedAt, {
      enabled: payoutDispatchPause.enabled,
      authoritativeSource: payoutDispatchPause.authoritativeSource,
      autoUnpause: false,
    }),
  );

  return {
    contractVersion: 'phase18-ops-health-v1',
    observedAt,
    components,
    alerts,
    payoutDispatchPause,
    financialAuthority: false,
  };
}

/** Explicit no-op guards used by tests — evaluation path must never call these. */
export const OPS_HEALTH_FORBIDDEN_MUTATIONS = {
  postLedgerEntry: false,
  mutateWithdrawal: false,
  overrideProviderHardLimit: false,
  overrideBudget: false,
  resolveReviewQueue: false,
  autoUnpausePayout: false,
} as const;
