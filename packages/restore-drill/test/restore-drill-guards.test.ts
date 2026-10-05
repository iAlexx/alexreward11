/**
 * Phase 18 Step 2A remediation — fail-closed restore-drill guards and contracts.
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
  assertSessionReadOnlyEnforced,
  computeObservedRpoSeconds,
  findRestoreDrillFinancialImportViolations,
  parseEndpointIdentity,
  parseRestoreDrillEnv,
  redactDatabaseUrl,
  runRestoreDrill,
  validateRestoredSchema,
  verifySelectedUserHistory,
  captureRepresentativeCounts,
  reconcileOutboxReadOnly,
  hashSelectedUserReference,
} from '../src/index.js';
import { RESTORE_DRILL_FORBIDDEN_CAPABILITIES, RESTORE_DRILL_FORBIDDEN_IMPORTS } from '../src/safety.js';
import { verifyPayoutDispatchPaused } from '../src/payout-pause.js';

vi.mock('@alex-rewards/db', async () => {
  const actual = await vi.importActual<typeof import('@alex-rewards/db')>('@alex-rewards/db');
  return {
    ...actual,
    listMigrationFiles: vi.fn(async () => [
      { version: '0001', fileName: '0001.sql', path: '0001.sql' },
    ]),
  };
});

type QueryResult = { rowCount: number; rows: unknown[] };

function createFakePool(handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
    end: vi.fn(async () => undefined),
    connect: vi.fn(),
  } as unknown as import('pg').Pool;
}

const baseEnv = {
  PHASE18_RESTORE_DRILL_ENABLED: 'true',
  PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@restore-host.example:5432/alex_rewards',
  PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
  PHASE18_RESTORE_EXPECTED_HOST: 'restore-host.example',
  PHASE18_SOURCE_DATABASE_HOST: 'source-host.example',
  PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
} as const;

function schemaAbsentHandler(sql: string): QueryResult {
  if (sql.includes('default_transaction_read_only') || sql.includes('transaction_read_only')) {
    return { rowCount: 1, rows: [{ default_ro: 'on', tx_ro: 'on' }] };
  }
  if (sql.includes('current_database')) {
    return { rowCount: 1, rows: [{ current_database: 'alex_rewards' }] };
  }
  if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
  if (sql.includes("to_regclass('public.schema_migrations')")) {
    return { rowCount: 1, rows: [{ present: false }] };
  }
  if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
  if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
  if (sql.includes('FROM outbox_events') && sql.includes('dedupe_key')) {
    return { rowCount: 1, rows: [{ count: '0' }] };
  }
  if (sql.includes('FROM outbox_events')) {
    return {
      rowCount: 1,
      rows: [
        {
          pending: '0',
          dispatched: '0',
          failed: '0',
          dead_letter: '0',
          oldest_pending_age_seconds: null,
          withdrawal_approved_pending: '0',
        },
      ],
    };
  }
  return { rowCount: 0, rows: [] };
}

describe('host-based isolation guard', () => {
  it('missing PHASE18_RESTORE_DATABASE_URL => refusal', () => {
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
      PHASE18_RESTORE_EXPECTED_HOST: 'restore-host.example',
      PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(RestoreTargetGuardError);
    try {
      assertRestoreTargetEnv(config);
    } catch (error: unknown) {
      expect((error as RestoreTargetGuardError).code).toBe('RESTORE_DATABASE_URL_MISSING');
    }
  });

  it('no DATABASE_URL fallback allowed', () => {
    expect(RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED).toBe(false);
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
      DATABASE_URL: 'postgres://u:p@ops/alex_rewards',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
      PHASE18_RESTORE_EXPECTED_HOST: 'restore-host.example',
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

  it('same database name + different explicitly bound target/source hosts => allowed', () => {
    const config = parseRestoreDrillEnv({ ...baseEnv });
    expect(() => assertRestoreTargetEnv(config)).not.toThrow();
    expect(FORBIDDEN_RESTORE_DATABASE_NAMES).not.toContain('alex_rewards');
    expect(FORBIDDEN_RESTORE_DATABASE_NAMES).not.toContain('railway');
  });

  it('same source/target host => refused', () => {
    const config = parseRestoreDrillEnv({
      ...baseEnv,
      PHASE18_SOURCE_DATABASE_HOST: 'restore-host.example',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/differ from PHASE18_SOURCE_DATABASE_HOST/);
  });

  it('semantically same DATABASE_URL endpoint with different credentials => refused', () => {
    const config = parseRestoreDrillEnv({
      ...baseEnv,
      DATABASE_URL: 'postgres://other:secret@restore-host.example:5432/alex_rewards',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/endpoint identity must differ/);
  });

  it('target hostname differs from PHASE18_RESTORE_EXPECTED_HOST => refused', () => {
    const config = parseRestoreDrillEnv({
      ...baseEnv,
      PHASE18_RESTORE_EXPECTED_HOST: 'other-host.example',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/does not equal PHASE18_RESTORE_EXPECTED_HOST/);
  });

  it('expected DB-name mismatch => refusal', async () => {
    await expect(
      runRestoreDrill({
        env: { ...baseEnv },
        pool: createFakePool((sql) => {
          if (sql.includes('default_transaction_read_only')) {
            return { rowCount: 1, rows: [{ default_ro: 'on', tx_ro: 'on' }] };
          }
          if (sql.includes('current_database')) {
            return { rowCount: 1, rows: [{ current_database: 'other_db' }] };
          }
          if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
          return { rowCount: 0, rows: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: 'CURRENT_DATABASE_MISMATCH' });
  });

  it('template DB name => refusal; application names allowed', () => {
    expect(FORBIDDEN_RESTORE_DATABASE_NAMES).toContain('postgres');
    const config = parseRestoreDrillEnv({
      ...baseEnv,
      PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@restore-host.example:5432/postgres',
      PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'postgres',
    });
    expect(() => assertRestoreTargetEnv(config)).toThrow(/forbidden template/);
  });

  it('endpoint identity ignores credentials', () => {
    const a = parseEndpointIdentity('postgres://a:b@host:5432/db');
    const b = parseEndpointIdentity('postgres://x:y@host:5432/db');
    expect(a).toEqual(b);
  });

  it('redacts credentials from URL fingerprints', () => {
    const redacted = redactDatabaseUrl('postgres://owner:s3cret@db.example:5432/alex_rewards');
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

  it('payout pause true alone is NOT enough for payout resume or full gate', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.payoutDispatchPause.payoutDispatchPausedAtValidation).toBe(true);
    expect(report.payoutResumeAllowed).toBe(false);
    expect(report.fullRestoreGatePass).toBe(false);
    expect(report.workflowReconciliation.status).toBe('NOT_OBSERVED');
    expect(report.blockchainReconciliation.liveChainReconciliation).toBe('NOT_OBSERVED');
  });
});

describe('representative counts fail-closed', () => {
  it('one required count query throws => FAIL and restoreValidationPass false', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool((sql) => {
        if (sql.includes('default_transaction_read_only')) {
          return { rowCount: 1, rows: [{ default_ro: 'on', tx_ro: 'on' }] };
        }
        if (sql.includes('current_database')) {
          return { rowCount: 1, rows: [{ current_database: 'alex_rewards' }] };
        }
        if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
        if (sql.includes("to_regclass('public.schema_migrations')")) {
          return { rowCount: 1, rows: [{ present: false }] };
        }
        if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
        if (sql.includes('FROM users') && sql.includes('COUNT')) {
          throw new Error('boom');
        }
        if (sql.includes('FROM outbox_events') && sql.includes('dedupe_key')) {
          return { rowCount: 1, rows: [{ count: '0' }] };
        }
        if (sql.includes('FROM outbox_events')) {
          return {
            rowCount: 1,
            rows: [
              {
                pending: '0',
                dispatched: '0',
                failed: '0',
                dead_letter: '0',
                oldest_pending_age_seconds: null,
                withdrawal_approved_pending: '0',
              },
            ],
          };
        }
        if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
        return { rowCount: 0, rows: [] };
      }),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.representativeCounts.restoredCaptureStatus).toBe('FAIL');
    expect(report.representativeCounts.comparisonStatus).toBe('NOT_EXECUTED');
    expect(report.representativeCounts.failedTables).toContain('users');
    expect(report.restoreValidationPass).toBe(false);
    expect(report.fullRestoreGatePass).toBe(false);
  });

  it('direct capture marks failedTables without inventing -1 counts', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM users')) throw new Error('missing');
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
    const result = await captureRepresentativeCounts(pool);
    expect(result.status).toBe('FAIL');
    expect(result.failedTables).toContain('users');
    expect(result.restoredCapture).toBeNull();
  });
});

describe('selected user history', () => {
  it('no allowlist => NOT_EXECUTED', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.selectedUserHistory.status).toBe('NOT_EXECUTED');
    expect(report.selectedUserHistory.reasonCode).toBe('NO_USER_ALLOWLIST');
  });

  it('invalid configured UUID => FAIL', async () => {
    const pool = createFakePool(() => ({ rowCount: 0, rows: [] }));
    const result = await verifySelectedUserHistory(pool, ['not-a-uuid']);
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('INVALID_USER_ID');
  });

  it('valid UUID but user missing => FAIL', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: false }] };
      return { rowCount: 0, rows: [] };
    });
    const result = await verifySelectedUserHistory(pool, [
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('SELECTED_USER_MISSING');
  });

  it('existing user with expected safe aggregates => PASS', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: true }] };
      if (sql.includes('GROUP BY state')) {
        return { rowCount: 1, rows: [{ state: 'COMPLETED', count: '2' }] };
      }
      if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '3' }] };
      return { rowCount: 0, rows: [] };
    });
    const result = await verifySelectedUserHistory(pool, [
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.status).toBe('PASS');
    expect(result.usersVerified).toBe(1);
    expect(result.users[0]?.userReference).toBe(hashSelectedUserReference('11111111-1111-4111-8111-111111111111'));
    expect(result.users[0]?.userReference).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(result.users[0]?.userIdPresent).toBe(true);
    expect(result.users[0]?.ledgerAccountCount).toBe(3);
    expect(result.users[0]?.ledgerProjectionRowCount).toBe(3);
    expect(result.users[0]?.withdrawalsByState.COMPLETED).toBe(2);
  });

  it('final runRestoreDrill report preserves selected-user aggregates', async () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_RESTORE_VERIFY_USER_IDS: userId,
      },
      pool: createFakePool((sql) => {
        if (sql.includes('default_transaction_read_only')) {
          return { rowCount: 1, rows: [{ default_ro: 'on', tx_ro: 'on' }] };
        }
        if (sql.includes('current_database')) {
          return { rowCount: 1, rows: [{ current_database: 'alex_rewards' }] };
        }
        if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
        if (sql.includes("to_regclass('public.schema_migrations')")) {
          return { rowCount: 1, rows: [{ present: false }] };
        }
        if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
        if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: true }] };
        if (sql.includes('GROUP BY state')) {
          return { rowCount: 1, rows: [{ state: 'APPROVED', count: '1' }] };
        }
        if (sql.includes('FROM outbox_events') && sql.includes('dedupe_key')) {
          return { rowCount: 1, rows: [{ count: '0' }] };
        }
        if (sql.includes('FROM outbox_events')) {
          return {
            rowCount: 1,
            rows: [
              {
                pending: '0',
                dispatched: '0',
                failed: '0',
                dead_letter: '0',
                oldest_pending_age_seconds: null,
                withdrawal_approved_pending: '0',
              },
            ],
          };
        }
        if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '4' }] };
        return { rowCount: 0, rows: [] };
      }),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.selectedUserHistory.status).toBe('PASS');
    expect(report.selectedUserHistory.users).toHaveLength(1);
    const expectedRef = hashSelectedUserReference(userId);
    expect(report.selectedUserHistory.users[0]).toMatchObject({
      userReference: expectedRef,
      userIdPresent: true,
      ledgerAccountCount: 4,
      ledgerProjectionRowCount: 4,
      rewardEventCount: 4,
      withdrawalCount: 4,
      withdrawalsByState: { APPROVED: 1 },
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain(userId);
    expect(json).toContain(expectedRef);
    expect(expectedRef).toMatch(/^[0-9a-f]{64}$/);
    expect(json).toContain('ledgerProjectionRowCount');
    expect(json).not.toMatch(/telegram/i);
    expect(json).not.toMatch(/walletAddress/i);
    expect(json).not.toMatch(/sessionToken/i);
    expect(json).not.toMatch(/authToken/i);
  });
});

describe('RPO direction', () => {
  it('observedRpoSeconds = sourceEvidence - restoredLatest when source is later', () => {
    expect(
      computeObservedRpoSeconds('2026-10-01T00:05:00.000Z', '2026-10-01T00:04:30.000Z'),
    ).toBe(30);
  });

  it('RTO/RPO values are observations, not policy targets', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
      timingOverrides: {
        restoreStartedAt: '2026-10-01T00:00:00.000Z',
        restoreAvailableAt: '2026-10-01T00:05:00.000Z',
        sourceEvidenceCapturedAt: '2026-10-01T00:05:00.000Z',
        restoredLatestAuthoritativeTimestamp: '2026-10-01T00:04:30.000Z',
      },
    });
    expect(report.timing.rtoTargetSeconds).toBe('OWNER_POLICY_REQUIRED');
    expect(report.timing.rpoTargetSeconds).toBe('OWNER_POLICY_REQUIRED');
    expect(report.timing.observedRestoreSeconds).toBe(300);
    expect(report.timing.observedRpoSeconds).toBe(30);
  });
});

describe('outbox financial ambiguity', () => {
  it('FAILED outbox blocks with OWNER_REVIEW_REQUIRED', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('dedupe_key')) return { rowCount: 1, rows: [{ count: '0' }] };
      return {
        rowCount: 1,
        rows: [
          {
            pending: '0',
            dispatched: '0',
            failed: '2',
            dead_letter: '0',
            oldest_pending_age_seconds: null,
            withdrawal_approved_pending: '0',
          },
        ],
      };
    });
    const result = await reconcileOutboxReadOnly(pool);
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.failed).toBe(2);
  });

  it('withdrawal.approved PENDING blocks with OWNER_REVIEW_REQUIRED', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('dedupe_key')) return { rowCount: 1, rows: [{ count: '0' }] };
      return {
        rowCount: 1,
        rows: [
          {
            pending: '1',
            dispatched: '0',
            failed: '0',
            dead_letter: '0',
            oldest_pending_age_seconds: '10',
            withdrawal_approved_pending: '1',
          },
        ],
      };
    });
    const result = await reconcileOutboxReadOnly(pool);
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.withdrawalApprovedPending).toBe(1);
  });

  it('duplicate dedupe keys => FAIL', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('dedupe_key')) return { rowCount: 1, rows: [{ count: '3' }] };
      return {
        rowCount: 1,
        rows: [
          {
            pending: '0',
            dispatched: '0',
            failed: '0',
            dead_letter: '0',
            oldest_pending_age_seconds: null,
            withdrawal_approved_pending: '0',
          },
        ],
      };
    });
    const result = await reconcileOutboxReadOnly(pool);
    expect(result.status).toBe('FAIL');
    expect(result.duplicateDedupeKeyAnomalies).toBe(3);
  });
});

describe('step2a resume / gate contract', () => {
  it('critical ledger invariant => FAIL and resume blocked', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({
        ok: false,
        findings: [{ code: 'DEBIT_CREDIT_IMBALANCE', severity: 'CRITICAL', message: 'imbalance' }],
      }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.ledgerInvariants.status).toBe('FAIL');
    expect(report.restoreValidationPass).toBe(false);
    expect(report.payoutResumeAllowed).toBe(false);
    expect(report.fullRestoreGatePass).toBe(false);
  });

  it('restore-reconcile DANGER => FAIL and resume blocked', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 2,
        warnCount: 0,
        byCategory: { approved_without_workflow: 1 },
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.withdrawalRestoreReconcile.status).toBe('FAIL');
    expect(report.restoreValidationPass).toBe(false);
    expect(report.payoutResumeAllowed).toBe(false);
  });

  it('workflow/chain NOT_OBSERVED => resume false and fullRestoreGatePass false', async () => {
    const report = await runRestoreDrill({
      env: { ...baseEnv },
      pool: createFakePool(schemaAbsentHandler),
      mode: 'DB_ONLY_STEP2A',
    });
    expect(report.workflowReconciliation.status).toBe('NOT_OBSERVED');
    expect(report.blockchainReconciliation.liveChainReconciliation).toBe('NOT_OBSERVED');
    expect(report.representativeCounts.comparisonStatus).toBe('NOT_EXECUTED');
    expect(report.payoutResumeAllowed).toBe(false);
    expect(report.fullRestoreGatePass).toBe(false);
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
      expect(stripped).not.toMatch(/local-unlock|signerSign/i);
      expect(stripped).not.toMatch(/\bworkflow\.start\b/);
      expect(stripped).not.toMatch(/\bworkflow\.execute\b/);
      expect(stripped).not.toMatch(/\bworkflow\.signal\b/);
      expect(stripped).not.toMatch(/\bworkflow\.signalWithStart\b/);
      expect(stripped).not.toMatch(/\bworkflow\.update\b/);
      expect(stripped).not.toMatch(/\bworkflow\.cancel\b/);
      expect(stripped).not.toMatch(/\bworkflow\.terminate\b/);
    }
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.sqlMutation).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.tonBroadcast).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoUnpause).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoResend).toBe(false);
  });

  it('rejects subpath/namespace/default/require/dynamic/reexport financial import bypasses', () => {
    const cases: Array<{ source: string; reason: string }> = [
      {
        source: `import { x } from '@alex-rewards/ledger/invariants.js';`,
        reason: 'SUBPATH_IMPORT',
      },
      {
        source: `import * as ledger from '@alex-rewards/ledger';`,
        reason: 'NAMESPACE_IMPORT',
      },
      {
        source: `import ledger from '@alex-rewards/ledger';`,
        reason: 'DEFAULT_IMPORT',
      },
      {
        source: `const x = require('@alex-rewards/withdrawals');`,
        reason: 'REQUIRE',
      },
      {
        source: `const x = await import('@alex-rewards/db');`,
        reason: 'DYNAMIC_IMPORT',
      },
      {
        source: `export * from '@alex-rewards/ledger';`,
        reason: 'REEXPORT_STAR',
      },
      {
        source: `export { checkLedgerInvariants } from '@alex-rewards/ledger';`,
        reason: 'REEXPORT_NAMED',
      },
      {
        source: `import { postLedger } from '@alex-rewards/ledger';`,
        reason: 'DISALLOWED_NAMED_IMPORT',
      },
    ];
    for (const { source, reason } of cases) {
      const violations = findRestoreDrillFinancialImportViolations(source);
      expect(violations.some((v) => v.reason === reason)).toBe(true);
    }
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { checkLedgerInvariants } from '@alex-rewards/ledger';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { runPhase10RestoreReconcileScan } from '@alex-rewards/withdrawals';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { runPhase10ChainHistoryReadonlyValidate } from '@alex-rewards/withdrawals';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { checkPhase10PayoutInvariants } from '@alex-rewards/withdrawals';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { assertPhase10ReadonlyValidationReportIntegrity } from '@alex-rewards/withdrawals';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { buildPhase10EconomicKey } from '@alex-rewards/withdrawals';`,
      ),
    ).toHaveLength(0);
    expect(
      findRestoreDrillFinancialImportViolations(
        `import { listMigrationFiles } from '@alex-rewards/db';`,
      ),
    ).toHaveLength(0);
  });
});

describe('read-only session enforcement', () => {
  it('default=off, transaction=off => FAIL', async () => {
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ default_ro: 'off', tx_ro: 'off' }],
    }));
    await expect(assertSessionReadOnlyEnforced(pool)).rejects.toMatchObject({
      code: 'READ_ONLY_NOT_ENFORCED',
    });
  });

  it('default=off, transaction=on => FAIL', async () => {
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ default_ro: 'off', tx_ro: 'on' }],
    }));
    await expect(assertSessionReadOnlyEnforced(pool)).rejects.toMatchObject({
      code: 'READ_ONLY_NOT_ENFORCED',
    });
  });

  it('default=on, transaction=off => FAIL', async () => {
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ default_ro: 'on', tx_ro: 'off' }],
    }));
    await expect(assertSessionReadOnlyEnforced(pool)).rejects.toMatchObject({
      code: 'READ_ONLY_NOT_ENFORCED',
    });
  });

  it('default=on, transaction=on => PASS', async () => {
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ default_ro: 'on', tx_ro: 'on' }],
    }));
    await expect(assertSessionReadOnlyEnforced(pool)).resolves.toBe(true);
  });
});

describe('critical schema shape', () => {
  const allColumns: Record<string, string[]> = {
    ledger_entries: [
      'ledger_transaction_id',
      'ledger_account_id',
      'direction',
      'amount_atomic',
    ],
    ledger_account_balances: [
      'ledger_account_id',
      'balance_atomic',
      'version',
      'last_ledger_transaction_id',
    ],
    withdrawals: [
      'state',
      'workflow_id',
      'reservation_ledger_tx_id',
      'settlement_ledger_tx_id',
      'release_ledger_tx_id',
    ],
    withdrawal_attempts: [
      'withdrawal_id',
      'broadcast_result_state',
      'broadcast_submitted_at',
      'broadcast_ambiguity_class',
    ],
    outbox_events: ['event_type', 'dedupe_key', 'aggregate_id', 'payload', 'status'],
    feature_flags: ['flag_key', 'environment', 'enabled'],
    reconciliation_issues: ['severity', 'status'],
  };

  const allEnums: Record<string, string[]> = {
    outbox_event_status: ['PENDING', 'DISPATCHED', 'FAILED', 'DEAD_LETTER'],
    reconciliation_issue_severity: ['INFO', 'WARNING', 'CRITICAL'],
    reconciliation_issue_status: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'],
  };

  function schemaShapePool(options?: {
    omitColumn?: string;
    omitEnum?: string;
  }) {
    return createFakePool((sql, params) => {
      if (sql.includes("to_regclass('public.schema_migrations')")) {
        return { rowCount: 1, rows: [{ present: true }] };
      }
      if (sql.includes('FROM schema_migrations') && !sql.includes('information_schema')) {
        return { rowCount: 1, rows: [{ version: '0001' }] };
      }
      if (sql.includes('to_regclass($1)')) {
        return { rowCount: 1, rows: [{ present: true }] };
      }
      if (sql.includes('information_schema.columns')) {
        const table = String(params?.[0] ?? '');
        const cols = [...(allColumns[table] ?? [])];
        if (options?.omitColumn?.startsWith(`${table}.`)) {
          const col = options.omitColumn.slice(table.length + 1);
          return {
            rowCount: cols.length - 1,
            rows: cols.filter((c) => c !== col).map((column_name) => ({ column_name })),
          };
        }
        return {
          rowCount: cols.length,
          rows: cols.map((column_name) => ({ column_name })),
        };
      }
      if (sql.includes('pg_enum')) {
        const enumName = String(params?.[0] ?? '');
        const labels = [...(allEnums[enumName] ?? [])];
        if (options?.omitEnum?.startsWith(`${enumName}.`)) {
          const label = options.omitEnum.slice(enumName.length + 1);
          return {
            rowCount: labels.length - 1,
            rows: labels.filter((l) => l !== label).map((enumlabel) => ({ enumlabel })),
          };
        }
        return {
          rowCount: labels.length,
          rows: labels.map((enumlabel) => ({ enumlabel })),
        };
      }
      return { rowCount: 0, rows: [] };
    });
  }

  it('migration markers present but critical column missing => FAIL', async () => {
    const result = await validateRestoredSchema(
      schemaShapePool({ omitColumn: 'withdrawals.workflow_id' }),
    );
    expect(result.status).toBe('FAIL');
    expect(result.criticalColumnsMissing).toContain('withdrawals.workflow_id');
  });

  it('required enum label missing => FAIL', async () => {
    const result = await validateRestoredSchema(
      schemaShapePool({ omitEnum: 'outbox_event_status.DEAD_LETTER' }),
    );
    expect(result.status).toBe('FAIL');
    expect(result.criticalEnumValuesMissing).toContain('outbox_event_status.DEAD_LETTER');
  });

  it('required shape complete => PASS', async () => {
    const result = await validateRestoredSchema(schemaShapePool());
    expect(result.status).toBe('PASS');
    expect(result.criticalColumnsMissing).toEqual([]);
    expect(result.criticalEnumValuesMissing).toEqual([]);
  });
});
