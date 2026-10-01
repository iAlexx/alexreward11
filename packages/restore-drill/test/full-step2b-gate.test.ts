/**
 * Phase 18 Step 2B.2A — FULL_STEP2B fail-closed restore reconciliation gate tests.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
vi.mock('@alex-rewards/db', async () => {
  const actual = await vi.importActual<typeof import('@alex-rewards/db')>('@alex-rewards/db');
  return {
    ...actual,
    listMigrationFiles: vi.fn(async () => [
      { version: '0001', fileName: '0001.sql', path: '0001.sql' },
    ]),
  };
});

import {
  RESTORE_DRILL_FORBIDDEN_CAPABILITIES,
  RESTORE_DRILL_FORBIDDEN_IMPORTS,
  assertRestoreTargetEnv,
  compareSourceRestoredCounts,
  computeFullRestoreGatePass,
  findRestoreDrillFinancialImportViolations,
  hashSelectedUserReference,
  isChainScopeEmpty,
  parseRestoreDrillEnv,
  parseSourceCountCapture,
  reconcileChainReadOnly,
  reconcileTemporalWorkflows,
  runRestoreDrill,
  serializeRestoreDrillReport,
  type CountCapture,
} from '../src/index.js';
import { captureChainScope } from '../src/chain-reconciliation.js';

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
  PHASE18_RESTORE_DRILL_MODE: 'FULL_STEP2B',
  PHASE18_TEMPORAL_ADDRESS: 'temporal.example:7233',
  PHASE18_TEMPORAL_NAMESPACE: 'default',
  PHASE18_SOURCE_COUNT_CAPTURE_PATH: '/tmp/phase18-source-counts.json',
} as const;

const emptyTables: Record<string, number> = {
  users: 0,
  ledger_transactions: 0,
  ledger_entries: 0,
  ledger_account_balances: 0,
  withdrawals: 0,
  withdrawal_attempts: 0,
  outbox_events: 0,
  reconciliation_issues: 0,
  reward_events: 0,
  ad_sessions: 0,
};

function sourceCapture(tables: Record<string, number> = emptyTables): CountCapture {
  return { capturedAt: '2026-10-01T03:00:00.000Z', tables: { ...tables } };
}

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

function schemaPassHandler(sql: string, params?: unknown[]): QueryResult {
  if (sql.includes('default_transaction_read_only') || sql.includes('transaction_read_only')) {
    return { rowCount: 1, rows: [{ default_ro: 'on', tx_ro: 'on' }] };
  }
  if (sql.includes('current_database')) {
    return { rowCount: 1, rows: [{ current_database: 'alex_rewards' }] };
  }
  if (sql.includes('version()')) return { rowCount: 1, rows: [{ version: 'PostgreSQL 16' }] };
  if (sql.includes("to_regclass('public.schema_migrations')")) {
    return { rowCount: 1, rows: [{ present: true }] };
  }
  if (sql.includes('to_regclass($1)')) {
    return { rowCount: 1, rows: [{ present: true }] };
  }
  if (sql.includes('FROM schema_migrations')) {
    return { rowCount: 1, rows: [{ version: '0001' }] };
  }
  if (sql.includes('information_schema.columns')) {
    const table = String(params?.[0] ?? '');
    const cols = allColumns[table] ?? ['id'];
    return { rowCount: cols.length, rows: cols.map((column_name) => ({ column_name })) };
  }
  if (sql.includes('pg_enum') || sql.includes('pg_type')) {
    const enumName = String(params?.[0] ?? '');
    const labels = allEnums[enumName] ?? ['PENDING'];
    return { rowCount: labels.length, rows: labels.map((enumlabel) => ({ enumlabel })) };
  }
  if (sql.includes('feature_flags')) return { rowCount: 1, rows: [{ enabled: true }] };
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
  if (sql.includes('GROUP BY state') && sql.includes('withdrawals')) {
    return { rowCount: 0, rows: [] };
  }
  if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
  if (sql.includes('FROM withdrawals') && sql.includes('workflow_id')) {
    return { rowCount: 0, rows: [] };
  }
  return { rowCount: 0, rows: [] };
}

describe('user privacy hashing', () => {
  it('report never contains raw UUID; uses 64-char SHA-256 reference', async () => {
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_RESTORE_DRILL_MODE: 'DB_ONLY_STEP2A',
        PHASE18_RESTORE_VERIFY_USER_IDS: userId,
      },
      pool: createFakePool((sql, params) => {
        const base = schemaPassHandler(sql, params);
        if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: true }] };
        if (sql.includes('GROUP BY state')) {
          return { rowCount: 1, rows: [{ state: 'COMPLETED', count: '1' }] };
        }
        return base;
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
    const ref = hashSelectedUserReference(userId);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ref).toBe(
      createHash('sha256')
        .update(`phase18-selected-user-v1\0${userId}`, 'utf8')
        .digest('hex'),
    );
    const json = serializeRestoreDrillReport(report);
    expect(json).not.toContain(userId);
    expect(json).toContain(ref);
    expect(hashSelectedUserReference(userId)).toBe(ref);
    expect(hashSelectedUserReference('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).not.toBe(ref);
    expect(json).not.toMatch(/telegram/i);
    expect(json).not.toMatch(/walletAddress/i);
    expect(json).not.toMatch(/sessionToken/i);
  });

  it('VERIFY_ALL_USERS enumerates users and hashes references', async () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_SOURCE_COUNT_CAPTURE_PATH: 'unused-overridden',
        PHASE18_RESTORE_VERIFY_ALL_USERS: 'true',
      },
      pool: createFakePool((sql, params) => {
        if (sql.includes('SELECT id::text') && sql.includes('FROM users')) {
          return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
        }
        if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: true }] };
        return schemaPassHandler(sql, params);
      }),
      mode: 'FULL_STEP2B',
      sourceCountCapture: sourceCapture(),
      temporalListPort: { listWithdrawalWorkflowIds: async () => [] },
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.selectedUserHistory.userCountConfigured).toBe(2);
    expect(report.selectedUserHistory.usersVerified).toBe(2);
    const json = JSON.stringify(report);
    for (const id of ids) {
      expect(json).not.toContain(id);
      expect(json).toContain(hashSelectedUserReference(id));
    }
  });

  it('VERIFY_ALL_USERS + explicit IDs is ambiguous FAIL', () => {
    const config = parseRestoreDrillEnv({
      ...baseEnv,
      PHASE18_RESTORE_VERIFY_ALL_USERS: 'true',
      PHASE18_RESTORE_VERIFY_USER_IDS: '11111111-1111-4111-8111-111111111111',
      PHASE18_SOURCE_COUNT_CAPTURE_PATH: '/tmp/x.json',
    });
    expect(() => assertRestoreTargetEnv(config, { mode: 'FULL_STEP2B' })).toThrow(
      /mutually exclusive/,
    );
  });
});

describe('source count artifact', () => {
  it('exact source/restored counts => PASS', () => {
    const source = sourceCapture({ ...emptyTables, users: 4 });
    const restored = sourceCapture({ ...emptyTables, users: 4 });
    const result = compareSourceRestoredCounts(source, restored);
    expect(result.status).toBe('PASS');
    expect(result.diff.users).toBe(0);
  });

  it('any nonzero diff => OWNER_REVIEW_REQUIRED', () => {
    const source = sourceCapture({ ...emptyTables, users: 4 });
    const restored = sourceCapture({ ...emptyTables, users: 5 });
    const result = compareSourceRestoredCounts(source, restored);
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.diff.users).toBe(1);
  });

  it('malformed source artifact => FAIL in FULL mode', async () => {
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_RESTORE_VERIFY_ALL_USERS: 'true',
      },
      pool: createFakePool((sql, params) => {
        if (sql.includes('SELECT id::text') && sql.includes('FROM users')) {
          return { rowCount: 0, rows: [] };
        }
        return schemaPassHandler(sql, params);
      }),
      mode: 'FULL_STEP2B',
      sourceCountCapture: { bogus: true },
      temporalListPort: { listWithdrawalWorkflowIds: async () => [] },
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.representativeCounts.comparisonStatus).toBe('FAIL');
    expect(report.fullRestoreGatePass).toBe(false);
  });

  it('refuses credential-bearing fields', () => {
    expect(() =>
      parseSourceCountCapture({
        capturedAt: '2026-10-01T00:00:00.000Z',
        tables: emptyTables,
        DATABASE_URL: 'postgres://x',
      }),
    ).toThrow(/credential/i);
  });
});

describe('temporal reconciliation', () => {
  it('zero DB / zero Temporal => PASS', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('workflow_id')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const result = await reconcileTemporalWorkflows({
      pool,
      temporal: { listWithdrawalWorkflowIds: async () => [] },
    });
    expect(result.status).toBe('PASS');
    expect(result.reasonCode).toBe('NO_WITHDRAWAL_WORKFLOWS_TO_RECONCILE');
    expect(result.temporalQueried).toBe(true);
  });

  it('DB expected / Temporal missing => OWNER_REVIEW_REQUIRED', async () => {
    const wid = '33333333-3333-4333-8333-333333333333';
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ id: wid, workflow_id: `withdrawal/${wid}`, state: 'APPROVED' }],
    }));
    const result = await reconcileTemporalWorkflows({
      pool,
      temporal: { listWithdrawalWorkflowIds: async () => [] },
    });
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.missingInTemporalCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(wid);
  });

  it('unexpected Temporal workflow => OWNER_REVIEW_REQUIRED', async () => {
    const pool = createFakePool(() => ({ rowCount: 0, rows: [] }));
    const unexpected = 'withdrawal/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = await reconcileTemporalWorkflows({
      pool,
      temporal: { listWithdrawalWorkflowIds: async () => [unexpected] },
    });
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.unexpectedInTemporalCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(unexpected);
  });

  it('malformed DB workflow_id => FAIL', async () => {
    const wid = '33333333-3333-4333-8333-333333333333';
    const pool = createFakePool(() => ({
      rowCount: 1,
      rows: [{ id: wid, workflow_id: 'wrong-id', state: 'APPROVED' }],
    }));
    const result = await reconcileTemporalWorkflows({
      pool,
      temporal: { listWithdrawalWorkflowIds: async () => [] },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('MALFORMED_DB_WORKFLOW_ID');
  });

  it('Temporal query error => FAIL', async () => {
    const pool = createFakePool(() => ({ rowCount: 0, rows: [] }));
    const result = await reconcileTemporalWorkflows({
      pool,
      temporal: {
        listWithdrawalWorkflowIds: async () => {
          throw new Error('unavailable');
        },
      },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('TEMPORAL_QUERY_FAILED');
  });
});

describe('chain reconciliation', () => {
  it('completely empty chain scope => PASS with NO_CHAIN_BOUND reason and no provider call', async () => {
    let providerCalls = 0;
    const pool = createFakePool(() => ({ rowCount: 1, rows: [{ count: '0' }] }));
    const scope = await captureChainScope(pool);
    expect(isChainScopeEmpty(scope)).toBe(true);
    const result = await reconcileChainReadOnly({
      pool,
      validateOverride: async () => {
        providerCalls += 1;
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe('PASS');
    expect(result.reasonCode).toBe('NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE');
    expect(result.chainScopeEmpty).toBe(true);
    expect(result.liveProviderQueryPerformed).toBe(false);
    expect(result.providerQueryPerformed).toBe(false);
    expect(providerCalls).toBe(0);
  });

  it('nonzero scope requires provider env; Mainnet refused', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('FROM withdrawals') && sql.includes('COUNT')) {
        return { rowCount: 1, rows: [{ count: '1' }] };
      }
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
    const result = await reconcileChainReadOnly({
      pool,
      env: {
        TON_PRIMARY_PROVIDER_KIND: 'toncenter-mainnet',
        TON_PRIMARY_PROVIDER_URL: 'https://primary.example',
        TON_SECONDARY_PROVIDER_KIND: 'tonapi',
        TON_SECONDARY_PROVIDER_URL: 'https://secondary.example',
        TON_TESTNET_JETTON_MASTER: 'EQCjetton',
      },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('MAINNET_OR_NON_TESTNET_REFUSED');
    expect(result.providerQueryPerformed).toBe(false);
  });
});

describe('full gate semantics', () => {
  it('one mandatory NOT_OBSERVED => fullRestoreGatePass false', () => {
    expect(
      computeFullRestoreGatePass({
        targetIsolationPass: true,
        databaseReadOnlyEnforced: true,
        schema: 'PASS',
        pause: 'PASS',
        pauseEnabled: true,
        ledger: 'PASS',
        withdrawalRestore: 'PASS',
        outbox: 'PASS',
        countComparison: 'PASS',
        selectedUser: 'PASS',
        workflow: 'NOT_OBSERVED',
        blockchain: 'PASS',
        withdrawalRecords: 'PASS',
      }),
    ).toBe(false);
  });

  it('one OWNER_REVIEW_REQUIRED => false', () => {
    expect(
      computeFullRestoreGatePass({
        targetIsolationPass: true,
        databaseReadOnlyEnforced: true,
        schema: 'PASS',
        pause: 'PASS',
        pauseEnabled: true,
        ledger: 'PASS',
        withdrawalRestore: 'PASS',
        outbox: 'PASS',
        countComparison: 'PASS',
        selectedUser: 'PASS',
        workflow: 'PASS',
        blockchain: 'OWNER_REVIEW_REQUIRED',
        withdrawalRecords: 'PASS',
      }),
    ).toBe(false);
  });

  it('every mandatory section PASS => fullRestoreGatePass true but resume remains Owner-gated', async () => {
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_RESTORE_VERIFY_ALL_USERS: 'true',
      },
      pool: createFakePool((sql, params) => {
        if (sql.includes('SELECT id::text') && sql.includes('FROM users')) {
          return { rowCount: 0, rows: [] };
        }
        return schemaPassHandler(sql, params);
      }),
      mode: 'FULL_STEP2B',
      sourceCountCapture: sourceCapture(),
      temporalListPort: { listWithdrawalWorkflowIds: async () => [] },
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    // selected users empty => NOT_EXECUTED => gate false; force via compute helper + resume fields
    expect(
      computeFullRestoreGatePass({
        targetIsolationPass: true,
        databaseReadOnlyEnforced: true,
        schema: 'PASS',
        pause: 'PASS',
        pauseEnabled: true,
        ledger: 'PASS',
        withdrawalRestore: 'PASS',
        outbox: 'PASS',
        countComparison: 'PASS',
        selectedUser: 'PASS',
        workflow: 'PASS',
        blockchain: 'PASS',
        withdrawalRecords: 'PASS',
      }),
    ).toBe(true);
    expect(report.payoutResumeAllowed).toBe(false);
    expect(report.resumeDecision).toBe('OWNER_APPROVAL_REQUIRED');
    expect(report.autoUnpause).toBe(false);
    expect(report.autoResend).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoUnpause).toBe(false);
    expect(RESTORE_DRILL_FORBIDDEN_CAPABILITIES.autoResend).toBe(false);
  });

  it('FULL happy path with empty users list still needs selectedUser PASS for gate', async () => {
    const userId = '44444444-4444-4444-8444-444444444444';
    const report = await runRestoreDrill({
      env: {
        ...baseEnv,
        PHASE18_RESTORE_VERIFY_USER_IDS: userId,
      },
      pool: createFakePool((sql, params) => {
        if (sql.includes('EXISTS')) return { rowCount: 1, rows: [{ present: true }] };
        if (sql.includes('GROUP BY state')) return { rowCount: 0, rows: [] };
        return schemaPassHandler(sql, params);
      }),
      mode: 'FULL_STEP2B',
      sourceCountCapture: sourceCapture(),
      temporalListPort: { listWithdrawalWorkflowIds: async () => [] },
      checkLedger: async () => ({ ok: true, findings: [] }),
      restoreReconcile: async () => ({
        dangerousCount: 0,
        warnCount: 0,
        byCategory: {},
        autoResend: false as const,
        autoUnpause: false as const,
      }),
    });
    expect(report.mode).toBe('FULL_STEP2B');
    expect(report.workflowReconciliation.status).toBe('PASS');
    expect(report.blockchainReconciliation.status).toBe('PASS');
    expect(report.blockchainReconciliation.reasonCode).toBe(
      'NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE',
    );
    expect(report.representativeCounts.comparisonStatus).toBe('PASS');
    expect(report.selectedUserHistory.status).toBe('PASS');
    expect(report.fullRestoreGatePass).toBe(true);
    expect(report.payoutResumeAllowed).toBe(false);
    expect(report.resumeDecision).toBe('OWNER_APPROVAL_REQUIRED');
    expect(JSON.stringify(report)).not.toContain(userId);
    expect(report.notes.some((n) => n.includes('FULL_STEP2B'))).toBe(true);
    expect(report.notes.some((n) => n.includes('Step 2A is DB-only'))).toBe(false);
  });
});

describe('DB_ONLY regression', () => {
  it('defaults to DB_ONLY_STEP2A and keeps NOT_OBSERVED temporal/chain', async () => {
    const config = parseRestoreDrillEnv({ ...baseEnv, PHASE18_RESTORE_DRILL_MODE: undefined });
    expect(config.drillMode).toBe('DB_ONLY_STEP2A');
    const report = await runRestoreDrill({
      env: { ...baseEnv, PHASE18_RESTORE_DRILL_MODE: 'DB_ONLY_STEP2A' },
      pool: createFakePool(schemaPassHandler),
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
    expect(report.workflowReconciliation.status).toBe('NOT_OBSERVED');
    expect(report.blockchainReconciliation.liveChainReconciliation).toBe('NOT_OBSERVED');
    expect(report.representativeCounts.comparisonStatus).toBe('NOT_EXECUTED');
    expect(report.representativeCounts.sourceCapture).toBeNull();
    expect(report.fullRestoreGatePass).toBe(false);
    expect(report.payoutResumeAllowed).toBe(false);
  });
});

describe('architecture boundary FULL additions', () => {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

  function listSrcFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) return listSrcFiles(child);
      if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) return [child];
      return [];
    });
  }

  it('allows only exact withdrawals symbols including chain readonly validate', () => {
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
        `import { runPhase10RestoreReconcileScan, settle } from '@alex-rewards/withdrawals';`,
      ).some((v) => v.reason === 'DISALLOWED_NAMED_IMPORT'),
    ).toBe(true);
  });

  it('never imports @alex-rewards/ton and forbids Temporal mutation APIs in source', () => {
    expect(RESTORE_DRILL_FORBIDDEN_IMPORTS).toContain('@alex-rewards/ton');
    for (const file of listSrcFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from\s+['"]@alex-rewards\/ton['"]/);
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(stripped).not.toMatch(/\bworkflow\.start\b/);
      expect(stripped).not.toMatch(/\bworkflow\.execute\b/);
      expect(stripped).not.toMatch(/\bworkflow\.signal\b/);
      expect(stripped).not.toMatch(/\bworkflow\.signalWithStart\b/);
      expect(stripped).not.toMatch(/\bworkflow\.update\b/);
      expect(stripped).not.toMatch(/\bworkflow\.cancel\b/);
      expect(stripped).not.toMatch(/\bworkflow\.terminate\b/);
      expect(stripped).not.toMatch(/\bsendBoc\b/);
    }
  });
});