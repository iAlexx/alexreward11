import { describe, expect, it } from 'vitest';
import {
  FakeTonChainProvider,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type EnumerateOutgoingJettonTransfersResult,
  type EnumeratedOutgoingJettonTransfer,
  type TonChainProvider,
  type TonNetworkGlobalId,
} from '@alex-rewards/ton';

import {
  PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE,
  evaluateChainHistoryForAcceptance,
  parsePhase10ChainHistoryEvidence,
} from '../src/phase10-chain-history-evidence.js';
import type { Phase10AuthoritativeHotWalletIdentity } from '../src/phase10-hot-wallet-identity.js';
import {
  assertPhase10ReadonlyValidationReportIntegrity,
  parsePhase10ReadonlyValidationReport,
  runPhase10ChainHistoryReadonlyValidate,
  runPhase10ChainHistoryReadonlyValidateForTests,
  type RunPhase10ChainHistoryReadonlyValidateInput,
  type RunPhase10ChainHistoryReadonlyValidateForTestsInput,
} from '../src/phase10-chain-history-readonly-validate.js';
import * as publicIndex from '../src/index.js';

const HOT = '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const JETTON_WALLET = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MASTER = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT = '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const WINDOW = {
  start: '2024-01-01T00:00:00.000Z',
  end: '2024-01-02T00:00:00.000Z',
} as const;
const PRIMARY_URL = 'https://toncenter-readonly-primary.example/api/v2';
const SECONDARY_URL = 'https://tonapi-readonly-secondary.example';

type _ProdHasNoFetchImpl = 'fetchImpl' extends keyof RunPhase10ChainHistoryReadonlyValidateInput
  ? never
  : true;
const _prodHasNoFetchImpl: _ProdHasNoFetchImpl = true;
void _prodHasNoFetchImpl;

const IDENTITY: Phase10AuthoritativeHotWalletIdentity = {
  hotWalletId: '00000000-0000-4000-8000-000000000001',
  addressRaw: HOT,
  signerReference: 'signer-fp-test',
  payoutJettonWalletAddress: JETTON_WALLET,
  signerType: 'FALLBACK_ENCRYPTED',
  networkCode: 'TON_TESTNET',
};

function seedTransfer(
  overrides: Partial<EnumeratedOutgoingJettonTransfer> &
    Pick<EnumeratedOutgoingJettonTransfer, 'queryId' | 'transferIdentity' | 'amountAtomic'>,
): EnumeratedOutgoingJettonTransfer {
  return {
    providerKind: 'fake',
    networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    hotWalletAddress: HOT,
    senderJettonWallet: JETTON_WALLET,
    jettonMaster: MASTER,
    transactionHash: `tx-${overrides.transferIdentity}`,
    transactionLt: '1',
    recipient: RECIPIENT,
    timestamp: '2024-01-01T12:00:00.000Z',
    success: true,
    bounced: false,
    ...overrides,
  };
}

class StubEnumerateProvider implements TonChainProvider {
  readonly networkGlobalId: TonNetworkGlobalId;
  private readonly result: EnumerateOutgoingJettonTransfersResult;
  private readonly healthOk: boolean;
  private readonly healthNetworkGlobalId: number;

  constructor(
    result: EnumerateOutgoingJettonTransfersResult,
    options?: {
      readonly networkGlobalId?: TonNetworkGlobalId;
      readonly healthOk?: boolean;
      readonly healthNetworkGlobalId?: number;
    },
  ) {
    this.result = result;
    this.networkGlobalId = options?.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
    this.healthOk = options?.healthOk ?? true;
    this.healthNetworkGlobalId =
      options?.healthNetworkGlobalId ?? options?.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
  }

  async getSeqno(): Promise<number> {
    return 0;
  }
  async getAccountState(address: string) {
    return {
      address,
      status: 'uninit' as const,
      balanceNanotons: '0',
      codeHash: null,
      dataHash: null,
      lastTransactionLt: null,
      lastTransactionHash: null,
    };
  }
  async getAccountBalance(address: string) {
    return { address, balanceNanotons: '0' };
  }
  async getJettonBalance(ownerAddress: string, jettonMaster: string) {
    return { ownerAddress, jettonMaster, balanceAtomic: '0' };
  }
  async sendBoc() {
    return { accepted: true };
  }
  async findTransactionsByQueryId() {
    return [];
  }
  async observeJettonTransfer() {
    return null;
  }
  async health() {
    return {
      ok: this.healthOk,
      networkGlobalId: this.healthNetworkGlobalId as TonNetworkGlobalId,
      latencyMs: 1,
      ...(this.healthOk ? {} : { detail: 'unhealthy' }),
    };
  }
  async enumerateOutgoingJettonTransfers(): Promise<EnumerateOutgoingJettonTransfersResult> {
    return this.result;
  }
}

function completeEmptyResult(providerKind: string): EnumerateOutgoingJettonTransfersResult {
  return {
    providerKind,
    networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    startedAt: '2024-01-01T00:00:00.000Z',
    completedAt: '2024-01-01T00:00:01.000Z',
    requestedWindowStart: WINDOW.start,
    requestedWindowEnd: WINDOW.end,
    pagesFetched: 1,
    recordsSeen: 0,
    cursorExhausted: true,
    windowFullyCovered: true,
    oldestObservedTimestamp: null,
    newestObservedTimestamp: null,
    truncated: false,
    warnings: [],
    transfers: [],
  };
}

function incompleteResult(providerKind: string): EnumerateOutgoingJettonTransfersResult {
  return {
    ...completeEmptyResult(providerKind),
    windowFullyCovered: false,
    truncated: true,
    warnings: ['truncated'],
  };
}

function baseInput(
  overrides: Partial<RunPhase10ChainHistoryReadonlyValidateForTestsInput> = {},
): RunPhase10ChainHistoryReadonlyValidateForTestsInput {
  return {
    db: {} as RunPhase10ChainHistoryReadonlyValidateForTestsInput['db'],
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    primary: { kind: 'toncenter', baseUrl: PRIMARY_URL, apiKey: null },
    secondary: { kind: 'tonapi', baseUrl: SECONDARY_URL, apiKey: null },
    jettonMaster: MASTER,
    networkCode: 'TON_TESTNET',
    realChainEnabled: false,
    fakeChainEnabled: false,
    generatedAt: '2024-01-02T00:00:00.000Z',
    identityOverride: IDENTITY,
    ...overrides,
  };
}

describe('Phase 10 chain history readonly validate', () => {
  it('keeps PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE false', () => {
    expect(PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE).toBe(false);
    expect(typeof publicIndex.runPhase10ChainHistoryReadonlyValidate).toBe('function');
    expect('runPhase10ChainHistoryReadonlyValidateForTests' in publicIndex).toBe(false);
  });

  it('refuses if real chain enabled', async () => {
    await expect(
      runPhase10ChainHistoryReadonlyValidateForTests(
        baseInput({
          realChainEnabled: true,
          primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
          secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
        }),
      ),
    ).rejects.toThrow(/WITHDRAWAL_REAL_CHAIN_ENABLED must be false/);
  });

  it('refuses if fake chain enabled', async () => {
    await expect(
      runPhase10ChainHistoryReadonlyValidateForTests(
        baseInput({
          fakeChainEnabled: true,
          primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
          secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
        }),
      ),
    ).rejects.toThrow(/WITHDRAWAL_FAKE_CHAIN_ENABLED must be false/);
  });

  it('wrong primary kind → FAIL_BINDING', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primary: { kind: 'tonapi', baseUrl: PRIMARY_URL },
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_BINDING');
    expect(report.validationOnly).toBe(true);
    expect(report.acceptanceEnabled).toBe(false);
    expect(report.notes.some((n) => n.includes("primary.kind must be 'toncenter'"))).toBe(true);
  });

  it('wrong secondary kind → FAIL_BINDING', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        secondary: { kind: 'toncenter', baseUrl: SECONDARY_URL },
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_BINDING');
    expect(report.notes.some((n) => n.includes("secondary.kind must be 'tonapi'"))).toBe(true);
  });

  it('provider health failure → FAIL_PROVIDER_HEALTH', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter'), {
          healthOk: false,
        }),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_PROVIDER_HEALTH');
    expect(report.primaryHealth.ok).toBe(false);
  });

  it('wrong network (networkGlobalId) → FAIL_PROVIDER_HEALTH', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi'), {
          healthNetworkGlobalId: -239,
        }),
      }),
    );
    expect(report.verdict).toBe('FAIL_PROVIDER_HEALTH');
    expect(report.secondaryHealth.networkGlobalId).toBe(-239);
  });

  it('incomplete primary → FAIL_INCOMPLETE_HISTORY', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(incompleteResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_INCOMPLETE_HISTORY');
    expect(report.primaryCoverage.windowFullyCovered).toBe(false);
    expect(report.primaryCoverage.truncated).toBe(true);
  });

  it('incomplete secondary → FAIL_INCOMPLETE_HISTORY', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(incompleteResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_INCOMPLETE_HISTORY');
    expect(report.secondaryCoverage.windowFullyCovered).toBe(false);
  });

  it('provider disagreement → FAIL_PROVIDER_DISAGREEMENT', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedEnumeratedOutgoingTransfer(
      seedTransfer({ queryId: '7', amountAtomic: '100', transferIdentity: 'p-only' }),
    );

    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: primary,
        secondaryProvider: secondary,
      }),
    );
    expect(report.verdict).toBe('FAIL_PROVIDER_DISAGREEMENT');
    expect(report.providerAgreement).toBe(false);
    expect(report.onlyPrimaryCount).toBe(1);
    expect(report.agreedTransferCount).toBe(0);
  });

  it('complete zero/zero → PASS_ZERO_OUTGOING', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('PASS_ZERO_OUTGOING');
    expect(report.providerAgreement).toBe(true);
    expect(report.agreedTransferCount).toBe(0);
    expect(report.validationOnly).toBe(true);
    expect(report.acceptanceEnabled).toBe(false);
    assertPhase10ReadonlyValidationReportIntegrity(report);
  });

  it('complete agreed transfer → PASS_WITH_OBSERVED_TRANSFERS', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const transfer = seedTransfer({
      queryId: '42',
      amountAtomic: '1000',
      transferIdentity: 'agreed-1',
    });
    primary.seedEnumeratedOutgoingTransfer(transfer);
    secondary.seedEnumeratedOutgoingTransfer({ ...transfer, providerKind: 'fake-secondary' });

    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: primary,
        secondaryProvider: secondary,
      }),
    );
    expect(report.verdict).toBe('PASS_WITH_OBSERVED_TRANSFERS');
    expect(report.providerAgreement).toBe(true);
    expect(report.agreedTransferCount).toBe(1);
    expect(report.agreedTransfers[0]?.queryId).toBe('42');
    expect(report.agreedTransfers[0]?.amountAtomic).toBe('1000');
    assertPhase10ReadonlyValidationReportIntegrity(report);
  });

  it('report digest tamper → assertIntegrity fails', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    const tampered = { ...report, reportDigest: '0'.repeat(64) };
    expect(() => assertPhase10ReadonlyValidationReportIntegrity(tampered)).toThrow(
      /reportDigest mismatch/,
    );
    expect(parsePhase10ReadonlyValidationReport(tampered).parsed).toBeNull();
  });

  it('validation report cannot be parsed as acceptance chain-history evidence', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    const asEvidence = parsePhase10ChainHistoryEvidence(report);
    expect(asEvidence.parsed).toBeNull();
    expect(
      asEvidence.errors.some(
        (e) => e.includes('validationOnly') || e.includes('not chain-history'),
      ),
    ).toBe(true);
    expect(evaluateChainHistoryForAcceptance(report).ok).toBe(false);
  });

  it('null identity → FAIL_BINDING', async () => {
    const report = await runPhase10ChainHistoryReadonlyValidateForTests(
      baseInput({
        identityOverride: null,
        primaryProvider: new StubEnumerateProvider(completeEmptyResult('toncenter')),
        secondaryProvider: new StubEnumerateProvider(completeEmptyResult('tonapi')),
      }),
    );
    expect(report.verdict).toBe('FAIL_BINDING');
  });

  it('production runner type has no fetchImpl and ForTests is not public', () => {
    expect(typeof runPhase10ChainHistoryReadonlyValidate).toBe('function');
    expect(typeof runPhase10ChainHistoryReadonlyValidateForTests).toBe('function');
    expect(
      Object.keys(publicIndex).includes('runPhase10ChainHistoryReadonlyValidateForTests'),
    ).toBe(false);
  });
});
