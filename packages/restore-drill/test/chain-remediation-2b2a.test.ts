/**
 * Phase 18 Step 2B.2A final remediation — restore-cutoff window + economic key matching.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
  PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
  buildPhase10EconomicKey,
  digestPhase10ReadonlyValidationReport,
  type Phase10ReadonlyValidationReport,
} from '@alex-rewards/withdrawals';

import {
  RESTORE_DRILL_READONLY_VALIDATE_FLAGS,
  assertRestoreTargetEnv,
  assertStrictTestnetNetworkEnv,
  deriveChainObservationBounds,
  matchConfirmedPayoutsToAgreedTransfers,
  parseRestoreDrillEnv,
  reconcileChainReadOnly,
  RestoreTargetGuardError,
  runRestoreDrill,
  type ExpectedConfirmedPayout,
} from '../src/index.js';

type QueryResult = { rowCount: number; rows: unknown[] };

function createFakePool(handler: (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
    end: vi.fn(async () => undefined),
    connect: vi.fn(),
  } as unknown as import('pg').Pool;
}

const RESTORE_TARGET = '2026-10-01T03:48:46.745Z';
const RECIPIENT_RAW = '0:0000000000000000000000000000000000000000000000000000000000000001';
const RECIPIENT_FRIENDLY = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAd99';
const MASTER_RAW = '0:1111111111111111111111111111111111111111111111111111111111111111';
const MASTER_FRIENDLY = 'EQAREREREREREREREREREREREREREREREREREREREREREeYT';
const HOT_RAW = '0:2222222222222222222222222222222222222222222222222222222222222222';
const HOT_FRIENDLY = 'EQAiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIp3C';
const SENDER_RAW = '0:3333333333333333333333333333333333333333333333333333333333333333';
const SENDER_FRIENDLY = 'EQAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM7SN';
const OTHER_RAW = '0:4444444444444444444444444444444444444444444444444444444444444444';

const providerEnv = {
  TON_PRIMARY_PROVIDER_KIND: 'toncenter',
  TON_PRIMARY_PROVIDER_URL: 'https://primary.example',
  TON_SECONDARY_PROVIDER_KIND: 'tonapi',
  TON_SECONDARY_PROVIDER_URL: 'https://secondary.example',
  TON_TESTNET_JETTON_MASTER: MASTER_RAW,
  PHASE18_CHAIN_NETWORK_CODE: 'TON_TESTNET',
  PHASE18_CHAIN_NETWORK_GLOBAL_ID: '-3',
} as const;

function nonemptyScopePool(): import('pg').Pool {
  return createFakePool((sql) => {
    if (sql.includes('SELECT id::text')) return { rowCount: 0, rows: [] };
    if (sql.includes('MIN(ts)') || sql.includes('earliest')) {
      return {
        rowCount: 1,
        rows: [{ earliest: '2024-01-01T00:00:00.000Z', latest: '2026-09-01T00:00:00.000Z' }],
      };
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM withdrawals') && !sql.includes('state')) {
      return { rowCount: 1, rows: [{ count: '1' }] };
    }
    if (sql.includes('settled_at IS NULL') || sql.includes("'UNKNOWN'")) {
      return { rowCount: 1, rows: [{ count: '0' }] };
    }
    if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [{ count: '0' }] };
    return { rowCount: 0, rows: [] };
  });
}

function makeReport(
  partial: Partial<Phase10ReadonlyValidationReport> &
    Pick<
      Phase10ReadonlyValidationReport,
      'verdict' | 'hotWalletAddress' | 'hotWalletJettonWallet' | 'jettonMaster' | 'agreedTransfers'
    >,
): Phase10ReadonlyValidationReport {
  const withoutDigest = {
    schemaVersion: PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
    generatedAt: RESTORE_TARGET,
    validationOnly: true as const,
    acceptanceEnabled: false as const,
    networkCode: 'TON_TESTNET' as const,
    networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    observationWindow: { start: '2024-01-01T00:00:00.000Z', end: RESTORE_TARGET },
    primaryProviderFingerprint: 'primary-fp',
    secondaryProviderFingerprint: 'secondary-fp',
    primaryHealth: { ok: true, networkGlobalId: -3, latencyMs: 1, detail: null },
    secondaryHealth: { ok: true, networkGlobalId: -3, latencyMs: 1, detail: null },
    primaryCoverage: {
      pagesFetched: 1,
      recordsSeen: 1,
      cursorExhausted: true,
      windowFullyCovered: true,
      truncated: false,
      oldestObservedTimestamp: null,
      newestObservedTimestamp: null,
      transferCount: partial.agreedTransfers.length,
      warnings: [],
    },
    secondaryCoverage: {
      pagesFetched: 1,
      recordsSeen: 1,
      cursorExhausted: true,
      windowFullyCovered: true,
      truncated: false,
      oldestObservedTimestamp: null,
      newestObservedTimestamp: null,
      transferCount: partial.agreedTransfers.length,
      warnings: [],
    },
    providerAgreement: true,
    agreedTransferCount: partial.agreedTransfers.length,
    onlyPrimaryCount: 0,
    onlySecondaryCount: 0,
    notes: [],
    ...partial,
  };
  return { ...withoutDigest, reportDigest: digestPhase10ReadonlyValidationReport(withoutDigest) };
}

const baseExpected: ExpectedConfirmedPayout = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  queryId: 'query-1',
  recipient: RECIPIENT_RAW,
  amountAtomic: '1000',
  jettonMaster: MASTER_RAW,
  hotWallet: HOT_RAW,
  senderJettonWallet: SENDER_RAW,
};

describe('restore target env', () => {
  const base = {
    PHASE18_RESTORE_DRILL_ENABLED: 'true',
    PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@restore-host.example:5432/alex_rewards',
    PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
    PHASE18_RESTORE_EXPECTED_HOST: 'restore-host.example',
    PHASE18_SOURCE_DATABASE_HOST: 'source-host.example',
    PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
    PHASE18_RESTORE_DRILL_MODE: 'FULL_STEP2B',
    PHASE18_TEMPORAL_ADDRESS: 'temporal.example:7233',
    PHASE18_TEMPORAL_NAMESPACE: 'default',
    PHASE18_SOURCE_COUNT_CAPTURE_PATH: '/tmp/x.json',
  } as const;

  it('FULL mode missing PHASE18_RESTORE_TARGET_AT => fail closed', () => {
    const config = parseRestoreDrillEnv({ ...base });
    expect(config.restoreTargetAt).toBeNull();
    expect(() => assertRestoreTargetEnv(config, { mode: 'FULL_STEP2B' })).toThrow(
      RestoreTargetGuardError,
    );
    try {
      assertRestoreTargetEnv(config, { mode: 'FULL_STEP2B' });
    } catch (error: unknown) {
      expect((error as RestoreTargetGuardError).code).toBe('RESTORE_TARGET_AT_MISSING');
    }
  });

  it('malformed restore target => fail closed', () => {
    expect(() =>
      parseRestoreDrillEnv({ ...base, PHASE18_RESTORE_TARGET_AT: 'not-a-timestamp' }),
    ).toThrow(RestoreTargetGuardError);
  });
});

describe('restore-cutoff window', () => {
  it('production flags still force realChainEnabled=false', () => {
    expect(RESTORE_DRILL_READONLY_VALIDATE_FLAGS.realChainEnabled).toBe(false);
  });

  it('provider validation input windowEnd equals restore target, not current time', async () => {
    let captured: { windowStart: string; windowEnd: string } | null = null;
    const ancient = '2020-01-01T00:00:00.000Z';
    await reconcileChainReadOnly({
      pool: nonemptyScopePool(),
      env: providerEnv,
      restoreTargetAt: RESTORE_TARGET,
      now: new Date('2099-01-01T00:00:00.000Z'),
      observationBoundsOverride: {
        earliestRelevantAt: ancient,
        latestRelevantAt: '2026-09-01T00:00:00.000Z',
      },
      checkPayoutInvariants: async () => ({
        withdrawalId: 'x',
        publicId: null,
        state: null,
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
      validateOverride: async (input) => {
        captured = { windowStart: input.windowStart, windowEnd: input.windowEnd };
        return makeReport({
          verdict: 'PASS_ZERO_OUTGOING',
          hotWalletAddress: HOT_RAW,
          hotWalletJettonWallet: SENDER_RAW,
          jettonMaster: MASTER_RAW,
          agreedTransfers: [],
        });
      },
    });
    expect(captured).toEqual({ windowStart: ancient, windowEnd: RESTORE_TARGET });
    expect(Date.parse(RESTORE_TARGET) - Date.parse(captured!.windowStart)).toBeGreaterThan(
      365 * 24 * 3600 * 1000,
    );
  });

  it('post-target provider activity is outside requested query window', async () => {
    let capturedEnd: string | null = null;
    await reconcileChainReadOnly({
      pool: nonemptyScopePool(),
      env: providerEnv,
      restoreTargetAt: RESTORE_TARGET,
      observationBoundsOverride: {
        earliestRelevantAt: '2026-01-01T00:00:00.000Z',
        latestRelevantAt: '2026-09-01T00:00:00.000Z',
      },
      checkPayoutInvariants: async () => ({
        withdrawalId: 'x',
        publicId: null,
        state: null,
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
      validateOverride: async (input) => {
        capturedEnd = input.windowEnd;
        return makeReport({
          verdict: 'PASS_WITH_OBSERVED_TRANSFERS',
          hotWalletAddress: HOT_RAW,
          hotWalletJettonWallet: SENDER_RAW,
          jettonMaster: MASTER_RAW,
          agreedTransfers: [
            {
              queryId: 'pre-target',
              amountAtomic: '1',
              recipient: RECIPIENT_RAW,
              transactionHash: null,
              transactionLt: null,
              timestamp: '2026-09-01T00:00:00.000Z',
            },
          ],
        });
      },
    });
    expect(capturedEnd).toBe(RESTORE_TARGET);
  });

  it('latestRelevantAt after restore target => FAIL', async () => {
    const result = await reconcileChainReadOnly({
      pool: nonemptyScopePool(),
      env: providerEnv,
      restoreTargetAt: RESTORE_TARGET,
      observationBoundsOverride: {
        earliestRelevantAt: '2026-01-01T00:00:00.000Z',
        latestRelevantAt: '2026-10-01T04:00:00.000Z',
      },
      checkPayoutInvariants: async () => ({
        withdrawalId: 'x',
        publicId: null,
        state: null,
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('RESTORED_CHAIN_TIMESTAMP_AFTER_TARGET');
  });

  it('zero chain scope still does not query providers', async () => {
    let calls = 0;
    const pool = createFakePool(() => ({ rowCount: 1, rows: [{ count: '0' }] }));
    const result = await reconcileChainReadOnly({
      pool,
      restoreTargetAt: RESTORE_TARGET,
      validateOverride: async () => {
        calls += 1;
        throw new Error('should not query');
      },
    });
    expect(result.status).toBe('PASS');
    expect(result.providerQueryPerformed).toBe(false);
    expect(result.observationWindowStart).toBeNull();
    expect(result.observationWindowEnd).toBe(RESTORE_TARGET);
    expect(calls).toBe(0);
  });

  it('deriveChainObservationBounds uses restored timestamps', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('MIN(ts)') || sql.includes('earliest')) {
        return {
          rowCount: 1,
          rows: [{ earliest: '2019-06-01T12:00:00.000Z', latest: '2026-08-01T00:00:00.000Z' }],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const derived = await deriveChainObservationBounds(pool);
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.bounds.earliestRelevantAt).toBe('2019-06-01T12:00:00.000Z');
    }
  });
});

describe('canonical economic matching', () => {
  it('raw recipient vs equivalent friendly recipient matches', () => {
    expect(
      buildPhase10EconomicKey({
        queryId: 'q1',
        amountAtomic: '1000',
        recipient: RECIPIENT_RAW,
        jettonMaster: MASTER_RAW,
      }),
    ).toBe(
      buildPhase10EconomicKey({
        queryId: 'q1',
        amountAtomic: '1000',
        recipient: RECIPIENT_FRIENDLY,
        jettonMaster: MASTER_FRIENDLY,
      }),
    );

    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [{ ...baseExpected, recipient: RECIPIENT_RAW, jettonMaster: MASTER_RAW }],
      report: {
        hotWalletAddress: HOT_FRIENDLY,
        hotWalletJettonWallet: SENDER_FRIENDLY,
        jettonMaster: MASTER_FRIENDLY,
        agreedTransfers: [
          {
            queryId: 'query-1',
            amountAtomic: '1000',
            recipient: RECIPIENT_FRIENDLY,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('PASS');
    expect(result.confirmedMatchedCount).toBe(1);
  });

  it('genuinely different recipient still FAILs', () => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        hotWalletAddress: HOT_RAW,
        hotWalletJettonWallet: SENDER_RAW,
        jettonMaster: MASTER_RAW,
        agreedTransfers: [
          {
            queryId: 'query-1',
            amountAtomic: '1000',
            recipient: OTHER_RAW,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('FAIL');
  });

  it('genuinely different master still FAILs', () => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        hotWalletAddress: HOT_RAW,
        hotWalletJettonWallet: SENDER_RAW,
        jettonMaster: OTHER_RAW,
        agreedTransfers: [
          {
            queryId: 'query-1',
            amountAtomic: '1000',
            recipient: RECIPIENT_RAW,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('FAIL');
  });

  it('duplicate transfer still FAILs', () => {
    const xfer = {
      queryId: 'query-1',
      amountAtomic: '1000',
      recipient: RECIPIENT_FRIENDLY,
      transactionHash: null,
      transactionLt: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        hotWalletAddress: HOT_RAW,
        hotWalletJettonWallet: SENDER_RAW,
        jettonMaster: MASTER_RAW,
        agreedTransfers: [xfer, xfer],
      },
    });
    expect(result.status).toBe('FAIL');
  });

  it('agreed unexpected transfer still FAILs', () => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        hotWalletAddress: HOT_RAW,
        hotWalletJettonWallet: SENDER_RAW,
        jettonMaster: MASTER_RAW,
        agreedTransfers: [
          {
            queryId: 'query-1',
            amountAtomic: '1000',
            recipient: RECIPIENT_RAW,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          {
            queryId: 'extra',
            amountAtomic: '5',
            recipient: OTHER_RAW,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('UNEXPECTED_OUTGOING_TRANSFER');
    expect(result.unexpectedOutgoingCount).toBe(1);
  });
});

describe('source capture target match', () => {
  it('source capture timestamp != restore target blocks full gate', async () => {
    const report = await runRestoreDrill({
      env: {
        PHASE18_RESTORE_DRILL_ENABLED: 'true',
        PHASE18_RESTORE_DATABASE_URL: 'postgres://u:p@restore-host.example:5432/alex_rewards',
        PHASE18_RESTORE_EXPECTED_DATABASE_NAME: 'alex_rewards',
        PHASE18_RESTORE_EXPECTED_HOST: 'restore-host.example',
        PHASE18_SOURCE_DATABASE_HOST: 'source-host.example',
        PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT: 'STAGING',
        PHASE18_RESTORE_DRILL_MODE: 'FULL_STEP2B',
        PHASE18_TEMPORAL_ADDRESS: 'temporal.example:7233',
        PHASE18_TEMPORAL_NAMESPACE: 'default',
        PHASE18_SOURCE_COUNT_CAPTURE_PATH: '/tmp/x.json',
        PHASE18_RESTORE_TARGET_AT: RESTORE_TARGET,
        PHASE18_RESTORE_VERIFY_USER_IDS: '44444444-4444-4444-8444-444444444444',
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
      mode: 'FULL_STEP2B',
      sourceCountCapture: {
        capturedAt: '2026-10-01T03:00:00.000Z',
        tables: {
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
        },
      },
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
    expect(report.workflowReconciliation.status).toBe('FAIL');
    expect(report.blockchainReconciliation.status).toBe('FAIL');
    expect(report.fullRestoreGatePass).toBe(false);
  });
});

describe('strict testnet still required', () => {
  it('accepts TON_TESTNET/-3', () => {
    expect(
      assertStrictTestnetNetworkEnv({
        PHASE18_CHAIN_NETWORK_CODE: 'TON_TESTNET',
        PHASE18_CHAIN_NETWORK_GLOBAL_ID: '-3',
      }).ok,
    ).toBe(true);
  });
});
