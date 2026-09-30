/**
 * Phase 18 Step 1 — read-only system/business health evaluation.
 * NEVER posts ledger, mutates withdrawals, overrides limits/budgets, or auto-unpauses.
 */

import type { Pool } from 'pg';
import {
  aggregateHealthStates,
  classifyProviderLimitUtilization,
  classifyUnresolvedReconciliation,
  mapProviderHealthStatus,
  stateFromMissingSignal,
} from './pure.js';
import type {
  BusinessAlertObservation,
  HealthComponentSnapshot,
  HealthState,
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

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
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

/**
 * Authoritative reconciliation signal: reconciliation_issues.
 * Review Queue RECONCILIATION_ISSUE cases are correlation only — never authority.
 */
async function readReconciliation(
  pool: Pool,
  observedAt: string,
): Promise<{ component: HealthComponentSnapshot; alert: BusinessAlertObservation }> {
  try {
    const counts = await pool.query<{
      critical_open: string;
      warning_open: string;
      info_open: string;
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE severity = 'CRITICAL' AND status IN ('OPEN', 'INVESTIGATING')
         )::text AS critical_open,
         COUNT(*) FILTER (
           WHERE severity = 'WARNING' AND status IN ('OPEN', 'INVESTIGATING')
         )::text AS warning_open,
         COUNT(*) FILTER (
           WHERE severity = 'INFO' AND status IN ('OPEN', 'INVESTIGATING')
         )::text AS info_open
       FROM reconciliation_issues`,
    );
    const criticalOpen = Number(counts.rows[0]?.critical_open ?? 0);
    const warningOpen = Number(counts.rows[0]?.warning_open ?? 0);
    const infoOpen = Number(counts.rows[0]?.info_open ?? 0);

    // Correlation only — must not drive reconciliation OK/DEGRADED.
    let reviewProjectionCount = 0;
    try {
      const review = await pool.query<{ open_count: string }>(
        `SELECT COUNT(*)::text AS open_count
           FROM review_cases
          WHERE case_type = 'RECONCILIATION_ISSUE'
            AND state = ANY(ARRAY['OPEN','IN_REVIEW','WAITING_INPUT','ESCALATED']::review_case_state[])`,
      );
      reviewProjectionCount = Number(review.rows[0]?.open_count ?? 0);
    } catch {
      reviewProjectionCount = 0;
    }

    const classified = classifyUnresolvedReconciliation({
      criticalOpen,
      warningOpen,
      infoOpen,
    });
    const details = {
      criticalOpen,
      warningOpen,
      infoOpen,
      authoritativeSource: 'reconciliation_issues',
      reviewQueueProjectionCount: reviewProjectionCount,
    };
    return {
      component: component('RECONCILIATION', classified.state, classified.reasonCode, observedAt, details),
      alert: alertBase(
        'RECONCILIATION_MISMATCH',
        classified.severity,
        classified.reasonCode,
        observedAt,
        details,
      ),
    };
  } catch {
    const missing = stateFromMissingSignal('RECONCILIATION_QUERY_FAILED');
    return {
      component: component('RECONCILIATION', missing.state, missing.reasonCode, observedAt),
      alert: alertBase('RECONCILIATION_MISMATCH', 'WARN', 'RECONCILIATION_QUERY_FAILED', observedAt),
    };
  }
}

/**
 * Provider-scoped health: each relevant registry provider is evaluated independently.
 * A healthy TEST_ONLY provider must not mask a degraded/unavailable ACTIVE provider.
 */
async function readProviderHealth(
  pool: Pool,
  observedAt: string,
): Promise<{ component: HealthComponentSnapshot; alerts: BusinessAlertObservation[] }> {
  const alerts: BusinessAlertObservation[] = [];
  try {
    const rows = await pool.query<{
      provider_code: string;
      provider_status: string;
      monetary_status: string;
      health_status: string | null;
    }>(
      `SELECT
         p.code AS provider_code,
         p.status::text AS provider_status,
         p.production_monetary_status::text AS monetary_status,
         (
           SELECT s.status::text
             FROM provider_health_snapshots s
            WHERE s.provider_id = p.id
            ORDER BY s.observed_at DESC, s.created_at DESC, s.id DESC
            LIMIT 1
         ) AS health_status
       FROM ad_providers p
      WHERE p.status IN ('ACTIVE', 'PAUSED')
      ORDER BY p.code`,
    );

    if (rows.rowCount === 0) {
      const missing = stateFromMissingSignal('NO_RELEVANT_PROVIDERS');
      alerts.push(alertBase('PROVIDER_HEALTH', 'OWNER_POLICY_REQUIRED', 'NO_RELEVANT_PROVIDERS', observedAt));
      return {
        component: component('ADS_PROVIDER', missing.state, missing.reasonCode, observedAt),
        alerts,
      };
    }

    const perProvider: Array<{
      code: string;
      monetaryStatus: string;
      healthState: HealthState;
      reason: string;
    }> = [];

    for (const row of rows.rows) {
      if (row.health_status === null) {
        // Missing observation fails closed as UNAVAILABLE (ads package rule).
        perProvider.push({
          code: row.provider_code,
          monetaryStatus: row.monetary_status,
          healthState: 'UNAVAILABLE',
          reason: 'NO_PROVIDER_OBSERVATION',
        });
        continue;
      }
      const healthState = mapProviderHealthStatus(row.health_status);
      perProvider.push({
        code: row.provider_code,
        monetaryStatus: row.monetary_status,
        healthState,
        reason: `PROVIDER_${healthState}`,
      });
    }

    const aggregate = aggregateHealthStates(perProvider.map((p) => p.healthState));
    const unavailableCount = perProvider.filter((p) => p.healthState === 'UNAVAILABLE').length;
    const degradedCount = perProvider.filter((p) => p.healthState === 'DEGRADED').length;
    const healthyCount = perProvider.filter((p) => p.healthState === 'OK').length;
    // Redacted codes only — never UUIDs in details for high-cardinality avoidance in metrics;
    // bounded list of provider codes is acceptable in the read model.
    const providerCodes = perProvider.map((p) => p.code).join(',');

    alerts.push(
      alertBase(
        'PROVIDER_HEALTH',
        aggregate === 'OK' ? 'INFO' : aggregate === 'DEGRADED' ? 'WARN' : 'DANGER',
        aggregate === 'OK' ? 'PROVIDERS_HEALTHY' : `PROVIDERS_${aggregate}`,
        observedAt,
        {
          relevantProviderCount: perProvider.length,
          healthyCount,
          degradedCount,
          unavailableCount,
          providerCodes,
          aggregateFailSafe: true,
        },
      ),
    );

    return {
      component: component('ADS_PROVIDER', aggregate, `PROVIDERS_${aggregate}`, observedAt, {
        relevantProviderCount: perProvider.length,
        healthyCount,
        degradedCount,
        unavailableCount,
        providerCodes,
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

/**
 * Exact UTC_DAY REQUEST/SUCCESS exhaustion from ad_daily_counters + effective ACTIVE rules.
 * HOUR / ROLLING_24H and country/risk-scoped rules are reported as unsupported, not invented.
 */
async function readProviderLimits(
  pool: Pool,
  observedAt: string,
  now: Date,
): Promise<BusinessAlertObservation[]> {
  try {
    const asOf = now.toISOString();
    const utcDay = utcDayString(now);

    const unsupported = await pool.query<{ unsupported_count: string }>(
      `SELECT COUNT(*)::text AS unsupported_count
         FROM provider_limit_rules
        WHERE status = 'ACTIVE'
          AND valid_from <= $1::timestamptz
          AND (valid_to IS NULL OR valid_to > $1::timestamptz)
          AND (
            limit_window IN ('HOUR', 'ROLLING_24H')
            OR country_code IS NOT NULL
            OR risk_tier IS NOT NULL
          )`,
      [asOf],
    );
    const unsupportedCount = Number(unsupported.rows[0]?.unsupported_count ?? 0);

    // Effective provider-wide UTC_DAY limits: min max_count per provider+metric among
    // ACTIVE currently-valid rules with null country/risk (stricter-only).
    const limits = await pool.query<{
      provider_id: string;
      limit_metric: string;
      effective_max: number;
    }>(
      `SELECT provider_id::text AS provider_id,
              limit_metric::text AS limit_metric,
              MIN(max_count)::int AS effective_max
         FROM provider_limit_rules
        WHERE status = 'ACTIVE'
          AND limit_window = 'UTC_DAY'
          AND limit_metric IN ('REQUEST', 'SUCCESS')
          AND country_code IS NULL
          AND risk_tier IS NULL
          AND valid_from <= $1::timestamptz
          AND (valid_to IS NULL OR valid_to > $1::timestamptz)
        GROUP BY provider_id, limit_metric`,
      [asOf],
    );

    if ((limits.rowCount ?? 0) === 0) {
      return [
        alertBase('PROVIDER_LIMIT', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt, {
          unsupportedActiveRuleDimensions: unsupportedCount,
        }),
      ];
    }

    let exhaustedRequest = 0;
    let exhaustedSuccess = 0;
    let belowLimitObserved = 0;

    for (const rule of limits.rows) {
      const counterColumn =
        rule.limit_metric === 'REQUEST' ? 'provider_requests' : 'successful_rewards';
      // Deterministic exact exhaustion: any user counter for today >= effective min limit.
      const usage = await pool.query<{ max_used: string | null }>(
        rule.limit_metric === 'REQUEST'
          ? `SELECT MAX(provider_requests)::text AS max_used
               FROM ad_daily_counters
              WHERE provider_id = $1::uuid
                AND utc_day = $2::date`
          : `SELECT MAX(successful_rewards)::text AS max_used
               FROM ad_daily_counters
              WHERE provider_id = $1::uuid
                AND utc_day = $2::date`,
        [rule.provider_id, utcDay],
      );
      void counterColumn;
      const maxUsedRaw = usage.rows[0]?.max_used ?? null;
      const maxUsed = maxUsedRaw === null ? 0 : Number(maxUsedRaw);
      const classified = classifyProviderLimitUtilization({
        used: maxUsed,
        limit: rule.effective_max,
      });
      if (classified.reasonCode === 'LIMIT_EXHAUSTED') {
        if (rule.limit_metric === 'REQUEST') exhaustedRequest += 1;
        else exhaustedSuccess += 1;
      } else {
        belowLimitObserved += 1;
      }
    }

    if (exhaustedRequest > 0 || exhaustedSuccess > 0) {
      return [
        alertBase('PROVIDER_LIMIT', 'DANGER', 'LIMIT_EXHAUSTED', observedAt, {
          exhaustedRequestDimensions: exhaustedRequest,
          exhaustedSuccessDimensions: exhaustedSuccess,
          belowLimitDimensions: belowLimitObserved,
          unsupportedActiveRuleDimensions: unsupportedCount,
          windowSupported: 'UTC_DAY',
        }),
      ];
    }

    return [
      alertBase('PROVIDER_LIMIT', 'OWNER_POLICY_REQUIRED', 'THRESHOLD_NOT_CONFIGURED', observedAt, {
        utcDayDimensionsObserved: limits.rowCount ?? 0,
        belowLimitDimensions: belowLimitObserved,
        unsupportedActiveRuleDimensions: unsupportedCount,
        nearExhaustionInvented: false,
      }),
    ];
  } catch {
    return [alertBase('PROVIDER_LIMIT', 'WARN', 'PROVIDER_LIMIT_QUERY_FAILED', observedAt)];
  }
}

/**
 * Uses provider_settlement_periods / provider_reporting_imports.
 * Does not invent variance materiality thresholds.
 */
async function readSettlement(
  pool: Pool,
  observedAt: string,
): Promise<BusinessAlertObservation> {
  try {
    const periods = await pool.query<{
      total: string;
      disputed: string;
      unresolved_nonzero_variance: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'DISPUTED')::text AS disputed,
         COUNT(*) FILTER (
           WHERE variance_atomic IS NOT NULL
             AND variance_atomic <> 0
             AND status IN ('OPEN', 'REPORTED', 'DISPUTED')
         )::text AS unresolved_nonzero_variance
       FROM provider_settlement_periods`,
    );
    const total = Number(periods.rows[0]?.total ?? 0);
    const disputed = Number(periods.rows[0]?.disputed ?? 0);
    const unresolvedNonzeroVariance = Number(periods.rows[0]?.unresolved_nonzero_variance ?? 0);

    const imports = await pool.query<{ failed_or_partial: string }>(
      `SELECT COUNT(*)::text AS failed_or_partial
         FROM provider_reporting_imports
        WHERE status IN ('FAILED', 'PARTIAL')`,
    );
    const failedOrPartial = Number(imports.rows[0]?.failed_or_partial ?? 0);

    if (total === 0) {
      return alertBase('PROVIDER_SETTLEMENT', 'OWNER_POLICY_REQUIRED', 'SIGNAL_NOT_CONFIGURED', observedAt, {
        table: 'provider_settlement_periods',
        periodCount: 0,
      });
    }

    if (disputed > 0) {
      return alertBase('PROVIDER_SETTLEMENT', 'DANGER', 'SETTLEMENT_DISPUTED', observedAt, {
        disputedCount: disputed,
        unresolvedNonzeroVariance,
        failedOrPartialImports: failedOrPartial,
      });
    }

    if (unresolvedNonzeroVariance > 0) {
      // Non-zero unresolved variance is an observable mismatch; magnitude threshold is Owner policy.
      return alertBase(
        'PROVIDER_SETTLEMENT',
        'OWNER_POLICY_REQUIRED',
        'UNRESOLVED_NONZERO_VARIANCE',
        observedAt,
        {
          unresolvedNonzeroVariance,
          failedOrPartialImports: failedOrPartial,
          varianceMagnitudeThresholdConfigured: false,
        },
      );
    }

    if (failedOrPartial > 0) {
      return alertBase('PROVIDER_SETTLEMENT', 'WARN', 'REPORTING_IMPORT_DEGRADED', observedAt, {
        failedOrPartialImports: failedOrPartial,
        periodCount: total,
      });
    }

    return alertBase('PROVIDER_SETTLEMENT', 'INFO', 'NO_OPEN_SETTLEMENT_MISMATCH', observedAt, {
      periodCount: total,
      disputedCount: 0,
      unresolvedNonzeroVariance: 0,
    });
  } catch {
    return alertBase('PROVIDER_SETTLEMENT', 'WARN', 'SETTLEMENT_QUERY_FAILED', observedAt);
  }
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
    components.push(component(id, 'UNKNOWN', 'SIGNAL_NOT_CONFIGURED', observedAt));
  }

  alerts.push(...(await readProviderLimits(input.pool, observedAt, now)));
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
