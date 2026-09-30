/**
 * Phase 18 Step 1 remediation — authoritative reconciliation / settlement / limits / health.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  aggregateHealthStates,
  assertBoundedMetricLabels,
  classifyProviderLimitUtilization,
  classifyUnresolvedReconciliation,
  containsSqlMutationStatement,
  effectiveMinLimit,
  evaluateOpsHealth,
  OPS_HEALTH_FORBIDDEN_MUTATIONS,
  stripCodeComments,
} from '../src/index.js';

type QueryResult = { rowCount: number; rows: unknown[] };

function createFakePool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
  } as unknown as import('pg').Pool;
}

function defaultBudget() {
  return { rowCount: 1, rows: [{ exhausted: '0', active: '0' }] };
}

describe('reconciliation_issues authority', () => {
  it('CRITICAL unresolved cannot be hidden by zero review_cases', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '2', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const recon = snapshot.components.find((c) => c.component === 'RECONCILIATION');
    expect(recon?.state).not.toBe('OK');
    expect(recon?.state).toBe('DEGRADED');
    expect(recon?.reasonCode).toBe('OPEN_CRITICAL_RECONCILIATION_ISSUES');
    expect(recon?.detailsRedacted?.authoritativeSource).toBe('reconciliation_issues');
    expect(recon?.detailsRedacted?.reviewQueueProjectionCount).toBe(0);
    const alert = snapshot.alerts.find((a) => a.alertClass === 'RECONCILIATION_MISMATCH');
    expect(alert?.severity).toBe('DANGER');
  });

  it('WARNING unresolved degrades health', () => {
    const classified = classifyUnresolvedReconciliation({
      criticalOpen: 0,
      warningOpen: 1,
      infoOpen: 0,
    });
    expect(classified.state).toBe('DEGRADED');
    expect(classified.severity).toBe('WARN');
  });

  it('resolved/dismissed issues do not count as unresolved', async () => {
    // Query filters OPEN/INVESTIGATING only — fake returns zeros when only RESOLVED exist.
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const recon = snapshot.components.find((c) => c.component === 'RECONCILIATION');
    expect(recon?.state).toBe('OK');
    expect(recon?.reasonCode).toBe('NO_UNRESOLVED_RECONCILIATION_ISSUES');
  });

  it('INFO-only open issues are represented honestly without DANGER', () => {
    const classified = classifyUnresolvedReconciliation({
      criticalOpen: 0,
      warningOpen: 0,
      infoOpen: 3,
    });
    expect(classified.state).toBe('OK');
    expect(classified.severity).toBe('INFO');
    expect(classified.reasonCode).toBe('OPEN_INFO_RECONCILIATION_ISSUES');
  });
});

describe('provider settlement tables', () => {
  it('DISPUTED settlement raises DANGER alert', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '2', disputed: '1', unresolved_nonzero_variance: '1' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const settlement = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_SETTLEMENT');
    expect(settlement?.severity).toBe('DANGER');
    expect(settlement?.reasonCode).toBe('SETTLEMENT_DISPUTED');
  });

  it('missing settlement data does not fabricate healthy settlement', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const settlement = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_SETTLEMENT');
    expect(settlement?.reasonCode).toBe('SIGNAL_NOT_CONFIGURED');
    expect(settlement?.severity).toBe('OWNER_POLICY_REQUIRED');
  });
});

describe('provider UTC_DAY exact exhaustion', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');

  it('detects exact REQUEST exhaustion from ad_daily_counters', async () => {
    const providerId = '11111111-1111-4111-8111-111111111111';
    const pool = createFakePool((sql, params) => {
      if (sql.includes('unsupported_count')) {
        return { rowCount: 1, rows: [{ unsupported_count: '0' }] };
      }
      if (sql.includes('MIN(max_count)') && sql.includes('UTC_DAY')) {
        return {
          rowCount: 1,
          rows: [{ provider_id: providerId, limit_metric: 'REQUEST', effective_max: 10 }],
        };
      }
      if (sql.includes('FROM ad_daily_counters') && sql.includes('provider_requests')) {
        expect(params?.[0]).toBe(providerId);
        return { rowCount: 1, rows: [{ max_used: '10' }] };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL', now });
    const limitAlert = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_LIMIT');
    expect(limitAlert?.reasonCode).toBe('LIMIT_EXHAUSTED');
    expect(limitAlert?.severity).toBe('DANGER');
    expect(limitAlert?.detailsRedacted?.exhaustedRequestDimensions).toBe(1);
  });

  it('detects exact SUCCESS exhaustion', async () => {
    const providerId = '22222222-2222-4222-8222-222222222222';
    const pool = createFakePool((sql) => {
      if (sql.includes('unsupported_count')) {
        return { rowCount: 1, rows: [{ unsupported_count: '0' }] };
      }
      if (sql.includes('MIN(max_count)') && sql.includes('UTC_DAY')) {
        return {
          rowCount: 1,
          rows: [{ provider_id: providerId, limit_metric: 'SUCCESS', effective_max: 5 }],
        };
      }
      if (sql.includes('FROM ad_daily_counters') && sql.includes('successful_rewards')) {
        return { rowCount: 1, rows: [{ max_used: '5' }] };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL', now });
    const limitAlert = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_LIMIT');
    expect(limitAlert?.reasonCode).toBe('LIMIT_EXHAUSTED');
    expect(limitAlert?.detailsRedacted?.exhaustedSuccessDimensions).toBe(1);
  });

  it('below-limit does not invent near threshold', () => {
    expect(classifyProviderLimitUtilization({ used: 4, limit: 10 }).reasonCode).toBe(
      'THRESHOLD_NOT_CONFIGURED',
    );
    expect(classifyProviderLimitUtilization({ used: 4, limit: 10 }).severity).toBe(
      'OWNER_POLICY_REQUIRED',
    );
    expect(effectiveMinLimit([10, 7, 20])).toBe(7);
  });

  it('expired/future rules are excluded by valid_from/valid_to SQL filters', async () => {
    const pool = createFakePool((sql) => {
      // When only expired/future rules exist, the effective UTC_DAY query returns empty.
      if (sql.includes('unsupported_count')) {
        return { rowCount: 1, rows: [{ unsupported_count: '0' }] };
      }
      if (sql.includes('MIN(max_count)') && sql.includes('UTC_DAY')) {
        expect(sql).toContain('valid_from <=');
        expect(sql).toContain('valid_to IS NULL OR valid_to >');
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('FROM ad_providers')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL', now });
    const limitAlert = snapshot.alerts.find((a) => a.alertClass === 'PROVIDER_LIMIT');
    expect(limitAlert?.reasonCode).toBe('SIGNAL_NOT_CONFIGURED');
  });
});

describe('provider-scoped health aggregation', () => {
  it('unrelated TEST_ONLY healthy snapshot cannot mask relevant provider degradation', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM ad_providers')) {
        return {
          rowCount: 2,
          rows: [
            {
              provider_code: 'ADSGRAM',
              provider_status: 'ACTIVE',
              monetary_status: 'APPROVED',
              health_status: 'UNAVAILABLE',
            },
            {
              provider_code: 'TEST_ONLY_FIXTURE',
              provider_status: 'ACTIVE',
              monetary_status: 'TEST_ONLY',
              health_status: 'HEALTHY',
            },
          ],
        };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });

    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const ads = snapshot.components.find((c) => c.component === 'ADS_PROVIDER');
    expect(ads?.state).toBe('UNAVAILABLE');
    expect(aggregateHealthStates(['OK', 'UNAVAILABLE'])).toBe('UNAVAILABLE');
  });

  it('missing relevant provider health remains fail-closed', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM ad_providers')) {
        return {
          rowCount: 1,
          rows: [
            {
              provider_code: 'ADSGRAM',
              provider_status: 'ACTIVE',
              monetary_status: 'APPROVED',
              health_status: null,
            },
          ],
        };
      }
      if (sql.includes('FROM reconciliation_issues')) {
        return {
          rowCount: 1,
          rows: [{ critical_open: '0', warning_open: '0', info_open: '0' }],
        };
      }
      if (sql.includes("case_type = 'RECONCILIATION_ISSUE'")) {
        return { rowCount: 1, rows: [{ open_count: '0' }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('outbox_events')) {
        return { rowCount: 1, rows: [{ pending: '0', oldest_age_seconds: '0' }] };
      }
      if (sql.includes('provider_limit_rules')) return { rowCount: 0, rows: [] };
      if (sql.includes('provider_settlement_periods')) {
        return {
          rowCount: 1,
          rows: [{ total: '0', disputed: '0', unresolved_nonzero_variance: '0' }],
        };
      }
      if (sql.includes('provider_reporting_imports')) {
        return { rowCount: 1, rows: [{ failed_or_partial: '0' }] };
      }
      if (sql.includes('reward_budget') || sql.includes('membership_bonus')) return defaultBudget();
      if (sql.includes('review_cases')) return { rowCount: 1, rows: [{ open_count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const snapshot = await evaluateOpsHealth({ pool, environment: 'LOCAL' });
    const ads = snapshot.components.find((c) => c.component === 'ADS_PROVIDER');
    expect(ads?.state).toBe('UNAVAILABLE');
  });
});

describe('ops-health architecture boundary', () => {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

  function listSrcFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) return listSrcFiles(child);
      if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) return [child];
      return [];
    });
  }

  it('rejects financial-package imports in production source', () => {
    const forbidden = [
      '@alex-rewards/ledger',
      '@alex-rewards/withdrawals',
      '@alex-rewards/rewards',
      '@alex-rewards/signing',
      '@alex-rewards/ton',
      '@alex-rewards/control-center',
      '@alex-rewards/ads',
      '@alex-rewards/wallets',
      '@alex-rewards/fraud',
    ];
    for (const file of listSrcFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const pkg of forbidden) {
        expect(source).not.toMatch(new RegExp(`from\\s+['"]${pkg.replace('/', '\\/')}['"]`));
      }
    }
  });

  it('rejects actual SQL mutation statements but allows comment documentation', () => {
    expect(
      containsSqlMutationStatement('// NEVER INSERT INTO ledger_entries\nSELECT 1'),
    ).toBe(false);
    expect(containsSqlMutationStatement('INSERT INTO ledger_entries VALUES (1)')).toBe(true);
    expect(containsSqlMutationStatement('UPDATE feature_flags SET enabled = false')).toBe(true);
    expect(containsSqlMutationStatement('DELETE FROM reconciliation_issues')).toBe(true);
    expect(stripCodeComments('/* INSERT INTO x */ SELECT 1')).not.toMatch(/INSERT\s+INTO/i);

    for (const file of listSrcFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(containsSqlMutationStatement(source)).toBe(false);
    }
  });

  it('forbids financial authority mutations and high-cardinality labels', () => {
    expect(OPS_HEALTH_FORBIDDEN_MUTATIONS.autoUnpausePayout).toBe(false);
    expect(assertBoundedMetricLabels({ provider_id: 'uuid' }).ok).toBe(false);
    expect(assertBoundedMetricLabels({ component: 'ADS_PROVIDER', state: 'OK' }).ok).toBe(true);
  });
});
