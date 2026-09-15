import { randomUUID } from 'node:crypto';
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
  PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
  PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE,
  buildPhase10ChainHistoryEvidence,
  evaluateChainHistoryForAcceptance,
} from '../src/phase10-chain-history-evidence.js';
import {
  PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION,
  PHASE10_CHAIN_HISTORY_INCOMPLETE,
  PHASE10_DUPLICATE_ECONOMIC_PAYOUT,
  PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY,
  PHASE10_PROVIDER_HISTORY_DISAGREEMENT,
  PHASE10_UNEXPECTED_OUTGOING,
  PHASE10_ZERO_UNEXPECTED,
  assertPhase10CollectorEvidenceIntegrity,
  collectPhase10LiveProviderBackedChainHistory,
  collectPhase10LiveProviderBackedChainHistoryForTests,
  collectPhase10ProviderBackedChainHistoryForTests,
  digestPhase10CollectorEvidence,
  loadPhase10ExpectedCampaignPayouts,
  toPhase10ChainHistoryEvidenceArtifact,
  type CollectPhase10LiveProviderBackedChainHistoryInput,
  type CollectPhase10ProviderBackedChainHistoryForTestsInput,
  type Phase10ExpectedCampaignPayout,
} from '../src/phase10-chain-history-collector.js';
import { fingerprintProviderEndpoint } from '../src/phase10-live-probes.js';
import * as publicIndex from '../src/index.js';

const HOT = '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const JETTON_WALLET = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MASTER = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT = '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const CONTROLLED_USER = '00000000-0000-4000-8000-000000000099';
const WINDOW = {
  start: '2024-01-01T00:00:00.000Z',
  end: '2024-01-02T00:00:00.000Z',
} as const;

type _NoCallerTransferArray =
  'providerEnumeratedOutgoingTransfers' extends keyof CollectPhase10ProviderBackedChainHistoryForTestsInput
    ? never
    : true;
const _collectInputHasNoCallerTransfers: _NoCallerTransferArray = true;
void _collectInputHasNoCallerTransfers;

type _LiveHasNoFetchImpl =
  'fetchImpl' extends keyof CollectPhase10LiveProviderBackedChainHistoryInput ? never : true;
type _LiveHasNoExpectedPayouts =
  'expectedPayouts' extends keyof CollectPhase10LiveProviderBackedChainHistoryInput ? never : true;
const _liveInputHasNoFetchImpl: _LiveHasNoFetchImpl = true;
const _liveInputHasNoExpectedPayouts: _LiveHasNoExpectedPayouts = true;
void _liveInputHasNoFetchImpl;
void _liveInputHasNoExpectedPayouts;

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

function expectedPayout(
  overrides: Partial<Phase10ExpectedCampaignPayout> = {},
): Phase10ExpectedCampaignPayout {
  return {
    withdrawalId: overrides.withdrawalId ?? randomUUID(),
    attemptId: overrides.attemptId ?? randomUUID(),
    queryId: overrides.queryId ?? '42',
    primaryTransactionIdentity: overrides.primaryTransactionIdentity ?? 'tx-primary',
    secondaryTransactionIdentity: overrides.secondaryTransactionIdentity ?? 'tx-secondary',
    recipient: overrides.recipient ?? RECIPIENT,
    amountAtomic: overrides.amountAtomic ?? '1000',
    jettonMaster: overrides.jettonMaster ?? MASTER,
    intendedAt: overrides.intendedAt ?? '2024-01-01T12:00:00.000Z',
  };
}

function baseCollectInput(
  primary: TonChainProvider,
  secondary: TonChainProvider,
  expectedPayouts: readonly Phase10ExpectedCampaignPayout[] = [],
): CollectPhase10ProviderBackedChainHistoryForTestsInput {
  return {
    campaignId: randomUUID(),
    hotWalletAddress: HOT,
    hotWalletJettonWallet: JETTON_WALLET,
    jettonMaster: MASTER,
    observationWindow: WINDOW,
    primary,
    secondary,
    primaryKind: 'toncenter',
    secondaryKind: 'tonapi',
    primaryEndpointFingerprint: 'https://primary.example:443',
    secondaryEndpointFingerprint: 'https://secondary.example:443',
    expectedPayouts,
    collectionId: randomUUID(),
    generatedAt: '2024-01-02T00:00:00.000Z',
  };
}

/** Provider stub that can return mismatched binding / incomplete coverage. */
class StubEnumerateProvider implements TonChainProvider {
  readonly networkGlobalId: TonNetworkGlobalId;
  private readonly result: EnumerateOutgoingJettonTransfersResult;
  private readonly healthOk: boolean;

  constructor(
    result: EnumerateOutgoingJettonTransfersResult,
    networkGlobalId?: TonNetworkGlobalId,
    healthOk = true,
  ) {
    this.result = result;
    this.networkGlobalId = networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
    this.healthOk = healthOk;
  }

  async getSeqno(): Promise<number> {
    return 0;
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
      networkGlobalId: this.networkGlobalId,
      latencyMs: 1,
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

describe('Phase 10 chain history collector', () => {
  it('keeps PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE false', () => {
    expect(PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE).toBe(false);
    expect(PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION).toBe('1.0.0');
    expect(
      'collectPhase10ProviderBackedChainHistoryForTests' in publicIndex ||
        'collectPhase10ProviderBackedChainHistory' in publicIndex ||
        'collectPhase10LiveProviderBackedChainHistoryForTests' in publicIndex,
    ).toBe(false);
    expect(typeof publicIndex.collectPhase10LiveProviderBackedChainHistory).toBe('function');
  });

  it('both providers agree → collector PASS candidate (ZERO_UNEXPECTED)', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const transfer = seedTransfer({
      queryId: '42',
      amountAtomic: '1000',
      transferIdentity: 'agreed-1',
    });
    primary.seedEnumeratedOutgoingTransfer(transfer);
    secondary.seedEnumeratedOutgoingTransfer({ ...transfer, providerKind: 'fake-secondary' });

    const expected = expectedPayout({ queryId: '42', amountAtomic: '1000' });
    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, [expected]),
    );

    expect(result.completeCoverage).toBe(true);
    expect(result.providerAgreement).toBe(true);
    expect(result.agreementVerdict).toBe('AGREED');
    expect(result.reconciliationResult).toBe(PHASE10_ZERO_UNEXPECTED);
    expect(result.matchedCount).toBe(1);
    expect(result.unexpectedOutgoingCount).toBe(0);
    expect(result.missingExpectedCount).toBe(0);
    expect(result.duplicateEconomicCount).toBe(0);
    expect(result.enumerationAuthority).toBe('PROVIDER_BACKED');
    expect(result.normalizedOutgoingTransfers).toHaveLength(1);

    const evidence = toPhase10ChainHistoryEvidenceArtifact(result);
    expect(evidence.reconciliationResult).toBe('ZERO_UNEXPECTED');
    expect(evidence.enumerationAuthority).toBe('PROVIDER_BACKED');
    // Acceptance still blocked while collector availability flag is false.
    expect(evaluateChainHistoryForAcceptance(evidence).ok).toBe(false);
  });

  it('primary-only transfer → PROVIDER_HISTORY_DISAGREEMENT', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedEnumeratedOutgoingTransfer(
      seedTransfer({ queryId: '7', amountAtomic: '100', transferIdentity: 'p-only' }),
    );

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.completeCoverage).toBe(true);
    expect(result.providerAgreement).toBe(false);
    expect(result.reconciliationResult).toBe(PHASE10_PROVIDER_HISTORY_DISAGREEMENT);
    expect(result.agreementVerdict).toBe(PHASE10_PROVIDER_HISTORY_DISAGREEMENT);
    expect(result.normalizedOutgoingTransfers).toHaveLength(0);
    expect(toPhase10ChainHistoryEvidenceArtifact(result).reconciliationResult).toBe(
      PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
    );
  });

  it('secondary-only transfer → PROVIDER_HISTORY_DISAGREEMENT', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    secondary.seedEnumeratedOutgoingTransfer(
      seedTransfer({ queryId: '8', amountAtomic: '100', transferIdentity: 's-only' }),
    );

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.reconciliationResult).toBe(PHASE10_PROVIDER_HISTORY_DISAGREEMENT);
    expect(result.providerAgreement).toBe(false);
  });

  it('detects unexpected outgoing', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const transfer = seedTransfer({
      queryId: '99',
      amountAtomic: '500',
      transferIdentity: 'unexpected',
    });
    primary.seedEnumeratedOutgoingTransfer(transfer);
    secondary.seedEnumeratedOutgoingTransfer(transfer);

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.reconciliationResult).toBe(PHASE10_UNEXPECTED_OUTGOING);
    expect(result.unexpectedOutgoingCount).toBe(1);
    expect(toPhase10ChainHistoryEvidenceArtifact(result).reconciliationResult).toBe(
      'UNEXPECTED_OUTGOING',
    );
  });

  it('detects missing expected payout', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const expected = expectedPayout({ queryId: 'missing-q', amountAtomic: '1000' });

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, [expected]),
    );
    expect(result.completeCoverage).toBe(true);
    expect(result.providerAgreement).toBe(true);
    expect(result.reconciliationResult).toBe(PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY);
    expect(result.missingExpectedCount).toBe(1);
    expect(toPhase10ChainHistoryEvidenceArtifact(result).reconciliationResult).toBe(
      PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
    );
  });

  it('detects duplicate economic payout', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const a = seedTransfer({
      queryId: '42',
      amountAtomic: '1000',
      transferIdentity: 'dup-a',
      transactionHash: 'hash-a',
      transactionLt: '1',
    });
    const b = seedTransfer({
      queryId: '42',
      amountAtomic: '1000',
      transferIdentity: 'dup-b',
      transactionHash: 'hash-b',
      transactionLt: '2',
    });
    primary.seedEnumeratedOutgoingTransfer(a);
    primary.seedEnumeratedOutgoingTransfer(b);
    secondary.seedEnumeratedOutgoingTransfer(a);
    secondary.seedEnumeratedOutgoingTransfer(b);

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, [
        expectedPayout({ queryId: '42', amountAtomic: '1000' }),
      ]),
    );
    expect(result.reconciliationResult).toBe(PHASE10_DUPLICATE_ECONOMIC_PAYOUT);
    expect(result.duplicateEconomicCount).toBe(1);
    expect(toPhase10ChainHistoryEvidenceArtifact(result).reconciliationResult).toBe(
      PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
    );
  });

  it('empty but COMPLETE provider histories → zero-outgoing allowed', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.completeCoverage).toBe(true);
    expect(result.providerAgreement).toBe(true);
    expect(result.reconciliationResult).toBe(PHASE10_ZERO_UNEXPECTED);
    expect(result.normalizedOutgoingTransfers).toHaveLength(0);
    expect(result.enumerationAuthority).toBe('PROVIDER_BACKED');
  });

  it('caller empty array cannot forge PROVIDER_BACKED / ZERO_UNEXPECTED', () => {
    const callerEmpty = buildPhase10ChainHistoryEvidence({
      hotWalletAddress: HOT,
      hotWalletJettonWallet: JETTON_WALLET,
      jettonMaster: MASTER,
      observationWindow: WINDOW,
      providerIdentity: {
        primaryKind: 'toncenter',
        primaryEndpointFingerprint: 'https://primary.example:443',
        secondaryKind: 'tonapi',
        secondaryEndpointFingerprint: 'https://secondary.example:443',
        independenceProven: true,
      },
      enumeratedOutgoingTransfers: [],
      expectedCampaignPayoutIdentities: [],
    });
    expect(callerEmpty.enumerationAuthority).toBe('CALLER_SUPPLIED_UNTRUSTED');
    expect(callerEmpty.reconciliationResult).toBe(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED);
    const evaluated = evaluateChainHistoryForAcceptance(callerEmpty);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.reasons.some((r) => r.includes(PHASE10_CHAIN_HISTORY_PROOF_REQUIRED))).toBe(
      true,
    );
  });

  it('incomplete coverage → CHAIN_HISTORY_INCOMPLETE', async () => {
    const incomplete = {
      ...completeEmptyResult('toncenter'),
      windowFullyCovered: false,
      truncated: true,
    };
    const primary = new StubEnumerateProvider(incomplete);
    const secondary = new StubEnumerateProvider(completeEmptyResult('tonapi'));

    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.completeCoverage).toBe(false);
    expect(result.reconciliationResult).toBe(PHASE10_CHAIN_HISTORY_INCOMPLETE);
    expect(result.enumerationAuthority).toBe('PROVIDER_BACKED');
  });

  it('evidence digest tamper → assertIntegrity fails', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const expected = expectedPayout({ queryId: '42', amountAtomic: '1000' });
    const result = await collectPhase10ProviderBackedChainHistoryForTests(
      baseCollectInput(primary, secondary, [expected]),
    );
    assertPhase10CollectorEvidenceIntegrity(result);

    const tamperedDigest = {
      ...result,
      collectorDigest: '0'.repeat(64),
      evidenceDigest: '0'.repeat(64),
    };
    expect(() => assertPhase10CollectorEvidenceIntegrity(tamperedDigest)).toThrow(
      /tamper|mismatch/i,
    );

    const tamperedExpectedField = {
      ...result,
      expectedPayouts: [
        {
          ...result.expectedPayouts[0]!,
          amountAtomic: '999999',
        },
      ],
    };
    expect(() => assertPhase10CollectorEvidenceIntegrity(tamperedExpectedField)).toThrow(
      /tamper|mismatch/i,
    );

    const tamperedIntendedAt = {
      ...result,
      expectedPayouts: [
        {
          ...result.expectedPayouts[0]!,
          intendedAt: '2024-01-01T13:00:00.000Z',
        },
      ],
    };
    expect(() => assertPhase10CollectorEvidenceIntegrity(tamperedIntendedAt)).toThrow(
      /tamper|mismatch/i,
    );

    const recomputed = digestPhase10CollectorEvidence({
      collectionId: result.collectionId,
      campaignId: result.campaignId,
      hotWalletAddress: result.hotWalletAddress,
      hotWalletJettonWallet: result.hotWalletJettonWallet,
      jettonMaster: result.jettonMaster,
      observationWindow: result.observationWindow,
      providerIdentity: result.providerIdentity,
      normalizedOutgoingTransfers: result.normalizedOutgoingTransfers,
      expectedPayouts: result.expectedPayouts,
      matchedCount: result.matchedCount,
      missingExpectedCount: result.missingExpectedCount,
      unexpectedOutgoingCount: result.unexpectedOutgoingCount,
      duplicateEconomicCount: result.duplicateEconomicCount,
      reconciliationResult: result.reconciliationResult,
      completeCoverage: result.completeCoverage,
      providerAgreement: result.providerAgreement,
    });
    expect(recomputed).toBe(result.collectorDigest);
  });

  it('null / invalid intendedAt → REFUSED by assertExpectedPayoutSet path', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(primary, secondary, [
          expectedPayout({ intendedAt: '' as unknown as string }),
        ]),
      ),
    ).rejects.toThrow(/REFUSE.*intendedAt missing or empty/i);

    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(primary, secondary, [expectedPayout({ intendedAt: 'not-a-timestamp' })]),
      ),
    ).rejects.toThrow(/REFUSE.*intendedAt is unparseable/i);
  });

  it('wrong Hot Wallet / Jetton wallet / master / network → refuse', async () => {
    const wrongHotTransfer = seedTransfer({
      queryId: '1',
      amountAtomic: '1',
      transferIdentity: 'wrong-hot',
      hotWalletAddress: '0:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    const badHot = new StubEnumerateProvider({
      ...completeEmptyResult('toncenter'),
      recordsSeen: 1,
      transfers: [wrongHotTransfer],
    });
    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(badHot, new StubEnumerateProvider(completeEmptyResult('tonapi')), []),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*hotWalletAddress/);

    const wrongJetton = seedTransfer({
      queryId: '1',
      amountAtomic: '1',
      transferIdentity: 'wrong-jetton',
      senderJettonWallet: '0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
    const badJetton = new StubEnumerateProvider({
      ...completeEmptyResult('toncenter'),
      recordsSeen: 1,
      transfers: [wrongJetton],
    });
    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(badJetton, new StubEnumerateProvider(completeEmptyResult('tonapi')), []),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*senderJettonWallet|Jetton wallet/i);

    const wrongMaster = seedTransfer({
      queryId: '1',
      amountAtomic: '1',
      transferIdentity: 'wrong-master',
      jettonMaster: '0:1111111111111111111111111111111111111111111111111111111111111111',
    });
    const badMaster = new StubEnumerateProvider({
      ...completeEmptyResult('toncenter'),
      recordsSeen: 1,
      transfers: [wrongMaster],
    });
    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(badMaster, new StubEnumerateProvider(completeEmptyResult('tonapi')), []),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*jettonMaster/);

    const badNetworkResult: EnumerateOutgoingJettonTransfersResult = {
      ...completeEmptyResult('toncenter'),
      networkGlobalId: -239,
    };
    const badNetworkProvider = new StubEnumerateProvider(badNetworkResult, -239);
    await expect(
      collectPhase10ProviderBackedChainHistoryForTests(
        baseCollectInput(
          badNetworkProvider,
          new StubEnumerateProvider(completeEmptyResult('tonapi')),
          [],
        ),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*networkGlobalId/);
  });

  it('Live path refuses fake kinds / mismatched fingerprints / unhealthy providers', async () => {
    const primaryUrl = 'https://testnet.toncenter.com/api/v2';
    const secondaryUrl = 'https://testnet.tonapi.io';
    const primaryFp = fingerprintProviderEndpoint(primaryUrl)!;
    const secondaryFp = fingerprintProviderEndpoint(secondaryUrl)!;
    const unusedDb = {
      query: async () => {
        throw new Error('db should not be queried before provider binding checks');
      },
    };
    const liveBase = {
      db: unusedDb as never,
      campaignId: randomUUID(),
      campaignWithdrawalIds: [] as const,
      campaignCreatedAt: '2024-01-01T00:00:00.000Z',
      controlledUserId: CONTROLLED_USER,
      hotWalletAddress: HOT,
      hotWalletJettonWallet: JETTON_WALLET,
      jettonMaster: MASTER,
      observationWindow: WINDOW,
      primary: { kind: 'toncenter', baseUrl: primaryUrl },
      secondary: { kind: 'tonapi', baseUrl: secondaryUrl },
      readinessPrimaryEndpointFingerprint: primaryFp,
      readinessSecondaryEndpointFingerprint: secondaryFp,
    };

    await expect(
      collectPhase10LiveProviderBackedChainHistory({
        ...liveBase,
        primary: { kind: 'fake', baseUrl: primaryUrl },
      }),
    ).rejects.toThrow(/primary\.kind must be 'toncenter'/);

    await expect(
      collectPhase10LiveProviderBackedChainHistory({
        ...liveBase,
        secondary: { kind: 'fake', baseUrl: secondaryUrl },
      }),
    ).rejects.toThrow(/secondary\.kind must be 'tonapi'/);

    await expect(
      collectPhase10LiveProviderBackedChainHistory({
        ...liveBase,
        readinessPrimaryEndpointFingerprint: 'https://wrong.example:443',
      }),
    ).rejects.toThrow(/primary endpoint fingerprint/);

    await expect(
      collectPhase10LiveProviderBackedChainHistory({
        ...liveBase,
        readinessSecondaryEndpointFingerprint: primaryFp,
      }),
    ).rejects.toThrow(/fingerprints must differ|secondary endpoint fingerprint/);

    await expect(
      collectPhase10LiveProviderBackedChainHistoryForTests({
        ...liveBase,
        fetchImpl: async (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          // Unhealthy: TonCenter masterchain fails; TonAPI status offline.
          if (url.includes('getMasterchainInfo')) {
            return new Response(JSON.stringify({ ok: false, error: 'down' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.endsWith('/v2/status')) {
            return new Response(JSON.stringify({ rest_online: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          throw new Error(`Unexpected live probe URL: ${url}`);
        },
      }),
    ).rejects.toThrow(/health must be ok|BINDING_REFUSED/);
  });

  it('loadPhase10ExpectedCampaignPayouts rejects missing INTENDED_PAYOUT_PROVEN', async () => {
    const withdrawalId = randomUUID();
    const fakeDb = {
      query: async () => ({ rows: [] }),
    };
    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
        campaignWithdrawalIds: [withdrawalId],
        window: WINDOW,
        campaignCreatedAt: '2024-01-01T00:00:00.000Z',
        expectedHotWalletAddress: HOT,
        expectedJettonMaster: MASTER,
        controlledUserId: CONTROLLED_USER,
      }),
    ).rejects.toThrow(/INTENDED_PAYOUT_PROVEN/);
  });

  it('loadPhase10ExpectedCampaignPayouts maps durable INTENDED_PAYOUT_PROVEN rows', async () => {
    const withdrawalId = randomUUID();
    const attemptId = randomUUID();
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: withdrawalId,
            attempt_id: attemptId,
            observed_query_id: '42',
            correlation_reference: 'corr-1',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '1000',
            evidence_summary: {
              primaryTransactionIdentity: 'prim-tx',
              secondaryTransactionIdentity: 'sec-tx',
              jettonMaster: MASTER,
            },
            resolved_at: new Date('2024-01-01T18:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '1000',
            jetton_master: MASTER,
            attempt_query_id: '42',
            broadcasted_at: new Date('2024-01-01T11:00:00.000Z'),
            broadcast_submitted_at: new Date('2024-01-01T10:30:00.000Z'),
            requested_at: new Date('2024-01-01T09:00:00.000Z'),
            hot_wallet_address: HOT,
          },
        ],
      }),
    };

    const payouts = await loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
      campaignWithdrawalIds: [withdrawalId],
      window: WINDOW,
      campaignCreatedAt: '2024-01-01T00:00:00.000Z',
      expectedHotWalletAddress: HOT,
      expectedJettonMaster: MASTER,
      controlledUserId: CONTROLLED_USER,
    });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      withdrawalId,
      attemptId,
      queryId: '42',
      primaryTransactionIdentity: 'prim-tx',
      secondaryTransactionIdentity: 'sec-tx',
      amountAtomic: '1000',
      recipient: RECIPIENT,
      jettonMaster: MASTER,
      intendedAt: '2024-01-01T10:30:00.000Z',
    });
  });

  it('broadcast_submitted_at takes precedence over later reconciliation timestamps', async () => {
    const withdrawalId = randomUUID();
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: withdrawalId,
            attempt_id: randomUUID(),
            observed_query_id: '42',
            correlation_reference: 'corr-1',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '1000',
            evidence_summary: {
              jettonMaster: MASTER,
              observedAt: '2024-01-01T20:00:00.000Z',
            },
            resolved_at: new Date('2024-01-01T22:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '1000',
            jetton_master: MASTER,
            attempt_query_id: '42',
            broadcasted_at: new Date('2024-01-01T15:00:00.000Z'),
            broadcast_submitted_at: new Date('2024-01-01T10:30:00.000Z'),
            requested_at: new Date('2024-01-01T09:00:00.000Z'),
            hot_wallet_address: HOT,
          },
        ],
      }),
    };

    const payouts = await loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
      campaignWithdrawalIds: [withdrawalId],
      window: WINDOW,
      campaignCreatedAt: '2024-01-01T00:00:00.000Z',
      expectedHotWalletAddress: HOT,
      expectedJettonMaster: MASTER,
      controlledUserId: CONTROLLED_USER,
    });
    expect(payouts[0]?.intendedAt).toBe('2024-01-01T10:30:00.000Z');
  });

  it('missing occurrence timestamps → REFUSE (never null intendedAt)', async () => {
    const withdrawalId = randomUUID();
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: withdrawalId,
            attempt_id: randomUUID(),
            observed_query_id: '42',
            correlation_reference: 'corr-1',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '1000',
            evidence_summary: { jettonMaster: MASTER },
            resolved_at: new Date('2024-01-01T12:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '1000',
            jetton_master: MASTER,
            attempt_query_id: '42',
            broadcasted_at: null,
            broadcast_submitted_at: null,
            requested_at: new Date('2024-01-01T09:00:00.000Z'),
            hot_wallet_address: HOT,
          },
        ],
      }),
    };

    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
        campaignWithdrawalIds: [withdrawalId],
        window: WINDOW,
        campaignCreatedAt: '2024-01-01T00:00:00.000Z',
        expectedHotWalletAddress: HOT,
        expectedJettonMaster: MASTER,
        controlledUserId: CONTROLLED_USER,
      }),
    ).rejects.toThrow(/REFUSE.*missing occurrence timestamp/i);
  });

  it('broadcast yesterday + resolved_at today inside window → intendedAt outside window refuse', async () => {
    const withdrawalId = randomUUID();
    const fakeDb = {
      query: async () => ({
        rows: [
          {
            withdrawal_id: withdrawalId,
            attempt_id: randomUUID(),
            observed_query_id: '42',
            correlation_reference: 'corr-1',
            observed_recipient: RECIPIENT,
            observed_amount_atomic: '1000',
            evidence_summary: { jettonMaster: MASTER },
            // resolved_at is inside window but must NEVER drive membership.
            resolved_at: new Date('2024-01-01T12:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '1000',
            jetton_master: MASTER,
            attempt_query_id: '42',
            broadcasted_at: new Date('2023-12-31T12:00:00.000Z'),
            broadcast_submitted_at: new Date('2023-12-31T11:00:00.000Z'),
            requested_at: new Date('2023-12-31T10:00:00.000Z'),
            hot_wallet_address: HOT,
          },
        ],
      }),
    };

    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, {
        campaignWithdrawalIds: [withdrawalId],
        window: WINDOW,
        campaignCreatedAt: '2023-12-01T00:00:00.000Z',
        expectedHotWalletAddress: HOT,
        expectedJettonMaster: MASTER,
        controlledUserId: CONTROLLED_USER,
      }),
    ).rejects.toThrow(/intendedAt outside observation window/);
  });
});
