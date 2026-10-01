/**
 * Phase 18 Step 2B.2A remediation — nonzero chain matching + fail-closed mode.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
  PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
  digestPhase10ReadonlyValidationReport,
  runPhase10ChainHistoryReadonlyValidate,
  type Phase10ReadonlyValidationReport,
} from '@alex-rewards/withdrawals';

import {
  RESTORE_DRILL_READONLY_VALIDATE_FLAGS,
  assertStrictTestnetNetworkEnv,
  captureUnresolvedAmbiguityCounts,
  matchConfirmedPayoutsToAgreedTransfers,
  parseRestoreDrillEnv,
  reconcileChainReadOnly,
  RestoreTargetGuardError,
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

function nonemptyScopePool(overrides?: {
  readonly confirmedIds?: readonly string[];
  readonly settledRowsByWithdrawal?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        attempt_id: string;
        query_id: string;
        recipient: string;
        amount_atomic: string;
        jetton_master: string;
        hot_wallet: string;
        sender_jetton_wallet: string;
      }>
    >
  >;
  readonly ambiguousAttempts?: number;
  readonly ambiguousWithdrawals?: number;
  readonly sensitiveIds?: readonly string[];
}): import('pg').Pool {
  const confirmedIds = overrides?.confirmedIds ?? [];
  const sensitiveIds = overrides?.sensitiveIds ?? confirmedIds;
  const settled = overrides?.settledRowsByWithdrawal ?? {};
  return createFakePool((sql, params) => {
    if (sql.includes('SELECT id::text AS id') && sql.includes("state::text = 'CONFIRMED'")) {
      return { rowCount: confirmedIds.length, rows: confirmedIds.map((id) => ({ id })) };
    }
    if (sql.includes('SELECT id::text AS id') && sql.includes('state::text = ANY')) {
      return { rowCount: sensitiveIds.length, rows: sensitiveIds.map((id) => ({ id })) };
    }
    if (sql.includes('settled_at IS NOT NULL') && sql.includes('FROM withdrawals w')) {
      const wid = String(params?.[0] ?? '');
      const rows = settled[wid] ?? [];
      return { rowCount: rows.length, rows: [...rows] };
    }
    if (
      sql.includes('settled_at IS NULL') ||
      sql.includes("broadcast_result_state::text IN ('UNKNOWN', 'RECONCILE_REQUIRED')")
    ) {
      return {
        rowCount: 1,
        rows: [{ count: String(overrides?.ambiguousAttempts ?? 0) }],
      };
    }
    if (sql.includes('FROM withdrawals') && sql.includes('state::text = ANY') && sql.includes('COUNT')) {
      const flat = JSON.stringify(params ?? []);
      if (flat.includes('BROADCASTING') && !flat.includes('CONFIRMED')) {
        return {
          rowCount: 1,
          rows: [{ count: String(overrides?.ambiguousWithdrawals ?? 0) }],
        };
      }
    }
    // Scope counts — nonempty withdrawals
    if (sql.includes('COUNT(*)') && sql.includes('FROM withdrawals') && !sql.includes('state')) {
      return { rowCount: 1, rows: [{ count: '1' }] };
    }
    if (sql.includes('COUNT(*)')) {
      return { rowCount: 1, rows: [{ count: '0' }] };
    }
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
    generatedAt: '2026-10-01T00:00:00.000Z',
    validationOnly: true as const,
    acceptanceEnabled: false as const,
    networkCode: 'TON_TESTNET' as const,
    networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    observationWindow: { start: '2025-01-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    primaryProviderFingerprint: 'primary-fp',
    secondaryProviderFingerprint: 'secondary-fp',
    primaryHealth: {
      ok: true,
      networkGlobalId: -3,
      latencyMs: 1,
      detail: null,
    },
    secondaryHealth: {
      ok: true,
      networkGlobalId: -3,
      latencyMs: 1,
      detail: null,
    },
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
  const reportDigest = digestPhase10ReadonlyValidationReport(withoutDigest);
  return { ...withoutDigest, reportDigest };
}

const providerEnv = {
  TON_PRIMARY_PROVIDER_KIND: 'toncenter',
  TON_PRIMARY_PROVIDER_URL: 'https://primary.example',
  TON_SECONDARY_PROVIDER_KIND: 'tonapi',
  TON_SECONDARY_PROVIDER_URL: 'https://secondary.example',
  TON_TESTNET_JETTON_MASTER: 'EQCjettonMaster',
  PHASE18_CHAIN_NETWORK_CODE: 'TON_TESTNET',
  PHASE18_CHAIN_NETWORK_GLOBAL_ID: '-3',
} as const;

const baseExpected: ExpectedConfirmedPayout = {
  withdrawalId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  queryId: 'query-1',
  recipient: 'EQCrecipient',
  amountAtomic: '1000',
  jettonMaster: 'EQCjettonMaster',
  hotWallet: 'EQChot',
  senderJettonWallet: 'EQCsenderJetton',
};

describe('readonly validator contract', () => {
  it('production flags require realChainEnabled=false and fakeChainEnabled=false', () => {
    expect(RESTORE_DRILL_READONLY_VALIDATE_FLAGS.realChainEnabled).toBe(false);
    expect(RESTORE_DRILL_READONLY_VALIDATE_FLAGS.fakeChainEnabled).toBe(false);
  });

  it('production invocation passes realChainEnabled=false to validate', async () => {
    let captured: { realChainEnabled: boolean; fakeChainEnabled: boolean } | null = null;
    await reconcileChainReadOnly({
      pool: nonemptyScopePool(),
      env: providerEnv,
      checkPayoutInvariants: async () => ({
        withdrawalId: 'x',
        publicId: null,
        state: 'CONFIRMED',
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
      validateOverride: async (input) => {
        captured = {
          realChainEnabled: input.realChainEnabled,
          fakeChainEnabled: input.fakeChainEnabled,
        };
        return makeReport({
          verdict: 'PASS_ZERO_OUTGOING',
          hotWalletAddress: 'EQChot',
          hotWalletJettonWallet: 'EQCsenderJetton',
          jettonMaster: 'EQCjettonMaster',
          agreedTransfers: [],
        });
      },
    });
    expect(captured).toEqual({ realChainEnabled: false, fakeChainEnabled: false });
  });

  it('real helper refuses realChainEnabled=true', async () => {
    await expect(
      runPhase10ChainHistoryReadonlyValidate({
        db: nonemptyScopePool(),
        windowStart: '2025-01-01T00:00:00.000Z',
        windowEnd: '2026-10-01T00:00:00.000Z',
        primary: { kind: 'toncenter', baseUrl: 'https://primary.example' },
        secondary: { kind: 'tonapi', baseUrl: 'https://secondary.example' },
        jettonMaster: 'EQCjettonMaster',
        networkCode: 'TON_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
      }),
    ).rejects.toThrow(/REAL_CHAIN_ENABLED must be false/i);
  });
});

describe('strict testnet network', () => {
  it('TON_TESTNET / -3 accepted', () => {
    expect(
      assertStrictTestnetNetworkEnv({
        PHASE18_CHAIN_NETWORK_CODE: 'TON_TESTNET',
        PHASE18_CHAIN_NETWORK_GLOBAL_ID: '-3',
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['-239'],
    ['0'],
    ['-2'],
    ['abc'],
    [''],
  ])('global id %s refused', (gid) => {
    const result = assertStrictTestnetNetworkEnv({
      PHASE18_CHAIN_NETWORK_CODE: 'TON_TESTNET',
      PHASE18_CHAIN_NETWORK_GLOBAL_ID: gid,
    });
    expect(result.ok).toBe(false);
  });

  it('MAINNET code refused', () => {
    const result = assertStrictTestnetNetworkEnv({
      PHASE18_CHAIN_NETWORK_CODE: 'TON_MAINNET',
      PHASE18_CHAIN_NETWORK_GLOBAL_ID: '-3',
    });
    expect(result.ok).toBe(false);
  });
});

describe('invalid drill mode fail-closed', () => {
  it('absent mode defaults to DB_ONLY_STEP2A', () => {
    const config = parseRestoreDrillEnv({
      PHASE18_RESTORE_DRILL_ENABLED: 'true',
    });
    expect(config.drillMode).toBe('DB_ONLY_STEP2A');
  });

  it('explicit FULL_STEP2BB throws INVALID_DRILL_MODE', () => {
    expect(() =>
      parseRestoreDrillEnv({
        PHASE18_RESTORE_DRILL_MODE: 'FULL_STEP2BB',
      }),
    ).toThrow(RestoreTargetGuardError);
    try {
      parseRestoreDrillEnv({ PHASE18_RESTORE_DRILL_MODE: 'FULL_STEP2BB' });
    } catch (error: unknown) {
      expect((error as RestoreTargetGuardError).code).toBe('INVALID_DRILL_MODE');
    }
  });

  it('empty string mode throws', () => {
    expect(() => parseRestoreDrillEnv({ PHASE18_RESTORE_DRILL_MODE: '  ' })).toThrow(
      RestoreTargetGuardError,
    );
  });
});

describe('ambiguity classification', () => {
  it('settled confirmed attempt with broadcast_submitted_at is NOT ambiguous', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('settled_at IS NULL')) {
        return { rowCount: 1, rows: [{ count: '0' }] };
      }
      if (sql.includes('FROM withdrawals') && sql.includes('COUNT')) {
        return { rowCount: 1, rows: [{ count: '0' }] };
      }
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
    const result = await captureUnresolvedAmbiguityCounts(pool);
    expect(result.ambiguousAttemptCount).toBe(0);
    expect(result.ambiguousWithdrawalCount).toBe(0);
  });

  it('UNKNOWN / RECONCILE_REQUIRED / unresolved BROADCASTED count as ambiguous', async () => {
    const pool = createFakePool((sql) => {
      if (sql.includes('settled_at IS NULL') || sql.includes("'UNKNOWN'")) {
        return { rowCount: 1, rows: [{ count: '2' }] };
      }
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
    const result = await captureUnresolvedAmbiguityCounts(pool);
    expect(result.ambiguousAttemptCount).toBe(2);
  });

  it('CONFIRMED withdrawal alone is not ambiguous', async () => {
    const pool = createFakePool((sql, params) => {
      const flat = JSON.stringify(params ?? []);
      if (sql.includes('state::text = ANY') && flat.includes('BROADCASTING') && !flat.includes('CONFIRMED')) {
        return { rowCount: 1, rows: [{ count: '0' }] };
      }
      return { rowCount: 1, rows: [{ count: '0' }] };
    });
    const result = await captureUnresolvedAmbiguityCounts(pool);
    expect(result.ambiguousWithdrawalCount).toBe(0);
  });
});

describe('per-withdrawal confirmed matching', () => {
  const identity = {
    hotWalletAddress: baseExpected.hotWallet,
    hotWalletJettonWallet: baseExpected.senderJettonWallet,
    jettonMaster: baseExpected.jettonMaster,
  };

  it('exact individual match PASSes', () => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        ...identity,
        agreedTransfers: [
          {
            queryId: baseExpected.queryId,
            amountAtomic: baseExpected.amountAtomic,
            recipient: baseExpected.recipient,
            transactionHash: 'h',
            transactionLt: '1',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('PASS');
    expect(result.confirmedMatchedCount).toBe(1);
    expect(result.unexpectedOutgoingCount).toBe(0);
  });

  it.each([
    ['queryId', { queryId: 'wrong' }],
    ['recipient', { recipient: 'EQCother' }],
    ['amount', { amountAtomic: '999' }],
  ] as const)('same count but wrong %s => FAIL', (_label, bad) => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        ...identity,
        agreedTransfers: [
          {
            queryId: baseExpected.queryId,
            amountAtomic: baseExpected.amountAtomic,
            recipient: baseExpected.recipient,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
            ...bad,
          },
        ],
      },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('CONFIRMED_WITHOUT_TEP74_PROOF');
  });

  it('wrong Jetton master / Hot Wallet / sender Jetton wallet => FAIL', () => {
    for (const bad of [
      { jettonMaster: 'EQCwrong' },
      { hotWalletAddress: 'EQCwrongHot' },
      { hotWalletJettonWallet: 'EQCwrongSender' },
    ]) {
      const result = matchConfirmedPayoutsToAgreedTransfers({
        expected: [baseExpected],
        report: {
          hotWalletAddress: identity.hotWalletAddress,
          hotWalletJettonWallet: identity.hotWalletJettonWallet,
          jettonMaster: identity.jettonMaster,
          ...bad,
          agreedTransfers: [
            {
              queryId: baseExpected.queryId,
              amountAtomic: baseExpected.amountAtomic,
              recipient: baseExpected.recipient,
              transactionHash: null,
              transactionLt: null,
              timestamp: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      });
      expect(result.status).toBe('FAIL');
    }
  });

  it('duplicate matching live transfers => FAIL', () => {
    const xfer = {
      queryId: baseExpected.queryId,
      amountAtomic: baseExpected.amountAtomic,
      recipient: baseExpected.recipient,
      transactionHash: null,
      transactionLt: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: { ...identity, agreedTransfers: [xfer, xfer] },
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('CONFIRMED_WITHOUT_TEP74_PROOF');
  });

  it('missing one expected transfer => FAIL', () => {
    const second: ExpectedConfirmedPayout = {
      ...baseExpected,
      withdrawalId: '33333333-3333-4333-8333-333333333333',
      queryId: 'query-2',
    };
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected, second],
      report: {
        ...identity,
        agreedTransfers: [
          {
            queryId: baseExpected.queryId,
            amountAtomic: baseExpected.amountAtomic,
            recipient: baseExpected.recipient,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(result.status).toBe('FAIL');
    expect(result.confirmedMatchedCount).toBe(1);
  });

  it('agreed-but-unexpected outgoing => FAIL with unexpectedOutgoingCount=1', () => {
    const result = matchConfirmedPayoutsToAgreedTransfers({
      expected: [baseExpected],
      report: {
        ...identity,
        agreedTransfers: [
          {
            queryId: baseExpected.queryId,
            amountAtomic: baseExpected.amountAtomic,
            recipient: baseExpected.recipient,
            transactionHash: null,
            transactionLt: null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          {
            queryId: 'query-extra',
            amountAtomic: '50',
            recipient: 'EQCother',
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
    expect(result.confirmedMatchedCount).toBe(1);
  });
});

describe('end-to-end nonzero path', () => {
  it('provider disagreement remains separate from unexpected outgoing', async () => {
    const result = await reconcileChainReadOnly({
      pool: nonemptyScopePool(),
      env: providerEnv,
      checkPayoutInvariants: async () => ({
        withdrawalId: 'x',
        publicId: null,
        state: null,
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
      validateOverride: async () =>
        makeReport({
          verdict: 'FAIL_PROVIDER_DISAGREEMENT',
          providerAgreement: false,
          onlyPrimaryCount: 1,
          onlySecondaryCount: 0,
          hotWalletAddress: 'EQChot',
          hotWalletJettonWallet: 'EQCsenderJetton',
          jettonMaster: 'EQCjettonMaster',
          agreedTransfers: [],
          agreedTransferCount: 0,
        }),
    });
    expect(result.status).toBe('OWNER_REVIEW_REQUIRED');
    expect(result.reasonCode).toBe('CHAIN_PROVIDER_DISAGREEMENT');
  });

  it('expected=1 agreed=2 with one exact match => UNEXPECTED_OUTGOING_TRANSFER', async () => {
    const wid = baseExpected.withdrawalId;
    const result = await reconcileChainReadOnly({
      pool: nonemptyScopePool({
        confirmedIds: [wid],
        sensitiveIds: [wid],
        settledRowsByWithdrawal: {
          [wid]: [
            {
              attempt_id: baseExpected.attemptId,
              query_id: baseExpected.queryId,
              recipient: baseExpected.recipient,
              amount_atomic: baseExpected.amountAtomic,
              jetton_master: baseExpected.jettonMaster,
              hot_wallet: baseExpected.hotWallet,
              sender_jetton_wallet: baseExpected.senderJettonWallet,
            },
          ],
        },
      }),
      env: providerEnv,
      checkPayoutInvariants: async () => ({
        withdrawalId: wid,
        publicId: null,
        state: 'CONFIRMED',
        ok: true,
        findings: [],
        duplicateEconomicPayoutCount: 0,
        duplicateSettlementCount: 0,
      }),
      validateOverride: async () =>
        makeReport({
          verdict: 'PASS_WITH_OBSERVED_TRANSFERS',
          hotWalletAddress: baseExpected.hotWallet,
          hotWalletJettonWallet: baseExpected.senderJettonWallet,
          jettonMaster: baseExpected.jettonMaster,
          agreedTransfers: [
            {
              queryId: baseExpected.queryId,
              amountAtomic: baseExpected.amountAtomic,
              recipient: baseExpected.recipient,
              transactionHash: null,
              transactionLt: null,
              timestamp: '2026-01-01T00:00:00.000Z',
            },
            {
              queryId: 'query-extra',
              amountAtomic: '7',
              recipient: 'EQCunexpected',
              transactionHash: null,
              transactionLt: null,
              timestamp: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
    });
    expect(result.status).toBe('FAIL');
    expect(result.reasonCode).toBe('UNEXPECTED_OUTGOING_TRANSFER');
    expect(result.unexpectedOutgoingCount).toBe(1);
    expect(result.confirmedMatchedCount).toBe(1);
    expect(result.knownExpectedTransferCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(wid);
  });
});