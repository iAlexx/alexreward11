/**
 * Phase 18 Step 2A — fail-closed restore-drill guards and contracts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  FORBIDDEN_RESTORE_DATABASE_NAMES,
  RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED,
  RestoreTargetGuardError,
  assertRestoreTargetEnv,
  parseRestoreDrillEnv,
  redactDatabaseUrl,
  runRestoreDrill,
} from '../src/index.js';
import { RESTORE_DRILL_FORBIDDEN_CAPABILITIES, RESTORE_DRILL_FORBIDDEN_IMPORTS } from '../src/safety.js';
import { verifyPayoutDispatchPaused } from '../src/payout-pause.js';

type QueryResult = { rowCount: number; rows: unknown[] };

function createFakePool(handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
    end: vi.fn(async () => undefined),
    connect: vi.fn(),
  } as unknown as import('pg').Pool;
}

describe('restore target hard guard', () => {
  it('missing PHASE18_RESTORE_DATABASE_URL => refusal', () => {
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
      PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(RestoreTargetGuardError);
    try {
      assertRestoreTargetEnv(config);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RestoreTargetGuardError);
      expect((error as RestoreTargetGuardError).code).toBe('RESTORE_DATABASE_URL_MISSING');
    }
  });

  it('no DATABASE_URL fallback allowed', () => {
    expect(RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.databaseUrlFallback).toBe(false);
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      DATABASE_URL: 'postgres://u:p@host/alex_rewards',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
      PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    });
    expect(config.restoreDatabaseUrl).toBeNull();
    expect(() => assertRestoreTargetEnv(config)).toThrow(/PHASE18_RESTORE_DATABASE_URL/);
  });

  it('drill disabled by default', () => {
    const config = parseRestoreDrillEnv({});
    expect(config.enabled).toBe(false);
    expect(() => assertRestoreTargetEnv(config)).toThrow(/PHASE18_RESTORE_DRILL_ENABLED/);
  });

  it('expected DB-name mismatch => refusal', async () => {
    await expect(
      runRestoreDrill({
        env: {
          PHASE18_RESTORE_DRILL_ENABLED: 'true',
          PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
          PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
          PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
        },
        pool: createFakePool((sql) => {
          if (sql.includes('current_database')) {
            return { rowCount: 1, rows: [{ current_database: 'alex_rewards_restore_other' }] };
          }
          if (sql.includes('version()')) {
            return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
          }
          return { rowCount: 0, rows: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: 'CURRENT_DATABASE_MISMATCH' });
  });

  it('operational connected DB name => refusal', async () => {
    await expect(
      runRestoreDrill({
        env: {
          PHASE18_RESTORE_DRILL_ENABLED: 'true',
          PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
          PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
          PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
        },
        pool: createFakePool((sql) => {
          if (sql.includes('current_database')) {
            return { rowCount: 1, rows: [{ current_database: 'alex_rewards' }] };
          }
          return { rowCount: 0, rows: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_OPERATIONAL_DATABASE_NAME' });
  });

  it('operational DB name => refusal', () => {
    expect(FORBIDDEN_RESTORE_DATABASE_NAMES).toContain('alex_rewards');
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
      PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/forbidden operational/);
  });

  it('restore URL equal to DATABASE_URL => refusal', () => {
    const url = 'postgres://u:p@host/alex_rewards_restore_drill';
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      PHASE18_RESTORE_DATABASE_URL: url,
      DATABASE_URL: url,
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
      PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/must not equal DATABASE_URL/);
  });

  it('redacts credentials from URL fingerprints', () => {
    const redacted = redactDatabaseUrl('postgres://owner:s3cret@db.example:5432/alex_rewards_restore_drill');
    expect(redacted).not.toContain('s3cret');
    expect(redacted).toContain('***');
  });
});

describe('payout pause gate', () => {
  it('payout pause missing => FAIL', async () => {
    const pool = createFakePool(() => ({ rowCount: 0, rows: [] }));
    const result = await verifyPayoutDispatchPaused(pool, 'STAGING');
    expect(result.status).toBe('FAIL');
    expect(result.payoutDispatchPausedAtValidation).toBeNull();
    expect(result.autoUnpause).toBe(false);
  });

  it('payout pause false => FAIL', async () => {
    const pool = createFakePool(() => ({ rowCount: 1, rows: [{ enabled: false }] }));
    const result = await verifyPayoutDispatchPaused(pool, 'STAGING');
    expect(result.status).toBe('FAIL');
    expect(result.payoutDispatchPausedAtValidation).toBe(false);
  });

  it('payout pause true alone is NOT enough for payout resume', async () => {
    // Minimal fake that gets past target + pause but leaves NOT_OBSERVED workflow/chain.
    const pool = createFakePool((sql) => {
      if (sql.includes('current_database')) {
        return { rowCount: 1, rows: [{ current_database: 'alex_rewards_restore_drill' }] };
      }
      if (sql.includes('version()')) {
        return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
      }
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rowCount: 1, rows: [{ present: true }] };
      }
      if (sql.includes('FROM schema_migrations') && sql.includes('ORDER BY version DESC')) {
        return { rowCount: 1, rows: [{ version: '0058', count: '58' }] };
      }
      if (sql.includes('FROM schema_migrations')) {
        // Return all expected versions is hard without listing — force schema FAIL path separately;
        // for this test we only care resume stays false when pause is true.
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('feature_flags') && sql.includes('PAYOUT_DISPATCH_PAUSE')) {
        return { rowCount: 1, rows: [{ enabled: true }] };
      }
      if (sql.includes('to_regclass')) {
        return { rowCount: 1, rows: [{ present: true }] };
      }
      return { rowCount: 1, rows: [{ count: '0' }] };
    });

    // Schema will FAIL (missing migrations) but pause true; resume must still be false.
    await expect(
      runRestoreDrill({
        env: {
          PHASE18_RESTORE_DRILL_ENABLED: 'true',
          PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
          PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
          PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
        },
        pool,
        mode: 'DB_ONLY_STEP2A',
      }),
    ).resolves.toMatchObject({
      payoutDispatchPause: { payoutDispatchPausedAtValidation: true, autoUnpause: false },
      payoutResumeAllowed: false,
      workflowReconciliation: { status: 'NOT_OBSERVED' },
      blockchainReconciliation: { liveChainReconciliation: 'NOT_OBSERVED' },
      autoUnpause: false,
      autoResend: false,
    });
  });
});

describe('step2a resume contract', () => {
  function schemaAbsentPool() {
    return createFakePool((sql) => {
      if (sql.includes('current_database')) {
        return { rowCount: 1, rows: [{ current_database: 'alex_rewards_restore_drill' }] };
      }
      if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rowCount: 1, rows: [{ present: false }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
  }

  it('critical ledger invariant => FAIL and resume blocked', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({
        ok: false,
        findings: [{ code: 'DEBIT_CREDIT_IMBALANCE', severity: 'CRITICAL' as const, message: 'imbalance' }],
      }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        historicalIsolatedBaselineCount: 0,
        findings: [],
        byCategory: {} as never,
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.ledgerInvariants.status).toBe('FAIL');
    expect(report.ledgerInvariants.reasonCode).toBe('CRITICAL_LEDGER_INVARIANT');
    expect(report.restoreValidationPass).toBe(false);
    expect(report.payoutResumeAllowed).toBe(false);
  });

  it('restore-reconcile DANGER => FAIL and resume blocked', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 2,
        warnCount: 0,
        historicalIsolatedBaselineCount: 0,
        findings: [],
        byCategory: {
          approved_without_workflow: 1,
          confirmed_without_settlement: 1,
        } as never,
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.withdrawalRestoreReconcile.status).toBe('FAIL');
    expect(report.withdrawalRestoreReconcile.reasonCode).toBe('RESTORE_RECONCILE_DANGER');
    expect(report.withdrawalRestoreReconcile.autoResend).toBe(false);
    expect(report.withdrawalRestoreReconcile.autoUnpause).toBe(false);
    expect(report.restoreValidationPass).toBe(false);
    expect(report.payoutResumeAllowed).toBe(false);
  });

  it('workflow live reconciliation NOT_OBSERVED => resume false', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.workflowReconciliation.status).toBe('NOT_OBSERVED');
    expect(report.payoutResumeAllowed).toBe(false);
  });

  it('chain live reconciliation NOT_OBSERVED => resume false', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.blockchainReconciliation.liveChainReconciliation).toBe('NOT_OBSERVED');
    expect(report.payoutResumeAllowed).toBe(false);
  });

  it('count evidence is read-only SELECT COUNT only', async () => {
    const queries: string[] = [];
    const pool = createFakePool((sql) => {
      queries.push(sql);
      if (sql.includes('current_database')) {
        return { rowCount: 1, rows: [{ current_database: 'alex_rewards_restore_drill' }] };
      }
      if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rowCount: 1, rows: [{ present: false }] };
      }
      if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
      if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
      return { rowCount: 0, rows: [] };
    });
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool,
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        historicalIsolatedBaselineCount: 0,
        findings: [],
        byCategory: {} as never,
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.representativeCounts.sourceCapture).toBeNull();
    expect(report.representativeCounts.diff).toBeNull();
    expect(report.representativeCounts.restoredCapture).not.toBeNull();
    const countSql = queries.filter((q) => /FROM users|FROM ledger_|FROM withdrawals|FROM outbox_events|FROM reward_events|FROM ad_sessions|FROM reconciliation_issues/i.test(q));
    for (const sql of countSql) {
      expect(sql.trimStart().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)).toBe(false);
    }
  });

  it('user-history verification with no allowlist => NOT_EXECUTED', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.selectedUserHistory.status).toBe('NOT_EXECUTED');
    expect(report.selectedUserHistory.reasonCode).toBe('NO_USER_ALLOWLIST');
  });

  it('RTO/RPO values are observations, not policy targets', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@host/alex_rewards_restore_drill',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards_restore_drill',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
      },
      pool: schemaAbsentPool(),
      mode: 'DB_ONLY_STEP2A',
      timingOverrides: {
        restoreStartedAt: '2026-10-01T00:00:00.000Z',
        restoreAvailableAt: '2026-10-01T00:05:00.000Z',
        sourceEvidenceCapturedAt: '2026-10-01T00:00:00.000Z',
        restoredLatestAuthoritativeTimestamp: '2026-10-01T00:00:30.000Z',
      },
    });
    expect(report.timing.rtoTargetSeconds).toBe('OWNER_POLICY_REQUIRED');
    expect(report.timing.rpoTargetSeconds).toBe('OWNER_POLICY_REQUIRED');
    expect(report.timing.observedRestoreSeconds).toBe(300);
    expect(report.timing.observedRpoSeconds).toBe(30);
  });
});

describe('restore-drill architecture boundary', () => {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

  function listSrcFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) return listSrcFiles(child);
      if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) return [child];
      return [];
    });
  }

  it('rejects forbidden financial mutation package imports', () => {
    for (const file of listSrcFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const pkg of RESTORE_DRILL_FORBIDDEN_IMPORTS) {
        expect(source).not.toMatch(new RegExp(`from\\s+['"]${pkg.replace('/', '\\/')}['"]`));
      }
    }
  });

  it('rejects SQL mutation statements and payout dispatch/replay paths', () => {
    for (const file of listSrcFiles(srcRoot)) {
      if (file.replaceAll('\\', '/').endsWith('/safety.ts')) continue;
      const source = readFileSync(file, 'utf8');
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(/\bINSERT\s+INTO\b/i.test(stripped)).toBe(false);
      expect(/\bUPDATE\s+[A-Za-z_]/i.test(stripped)).toBe(false);
      expect(/\bDELETE\s+FROM\b/i.test(stripped)).toBe(false);
      expect(/\bMERGE\s+INTO\b/i.test(stripped)).toBe(false);
      expect(stripped).not.toMatch(/\bsendBoc\b/);
      expect(stripped).not.toMatch(/\bpostLedger\b/);
      expect(stripped).not.toMatch(/setFeatureFlagEnabled/);
      expect(stripped).not.toMatch(/local-unlock|signerSign|workflow\.start/i);
    }
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.sqlMutation).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.tonBroadcast).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoUnpause).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoResend).toBe(false);
  });
});
