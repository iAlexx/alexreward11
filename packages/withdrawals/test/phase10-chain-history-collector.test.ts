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
  collectPhase10ProviderBackedChainHistory,
  digestPhase10CollectorEvidence,
  loadPhase10ExpectedCampaignPayouts,
  toPhase10ChainHistoryEvidenceArtifact,
  type CollectPhase10ProviderBackedChainHistoryInput,
  type Phase10ExpectedCampaignPayout,
} from '../src/phase10-chain-history-collector.js';

const HOT = '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const JETTON_WALLET = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MASTER = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT = '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const WINDOW = {
  start: '2024-01-01T00:00:00.000Z',
  end: '2024-01-02T00:00:00.000Z',
} as const;

type _NoCallerTransferArray =
  'providerEnumeratedOutgoingTransfers' extends keyof CollectPhase10ProviderBackedChainHistoryInput
    ? never
    : true;
const _collectInputHasNoCallerTransfers: _NoCallerTransferArray = true;
void _collectInputHasNoCallerTransfers;

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
): CollectPhase10ProviderBackedChainHistoryInput {
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

  constructor(
    result: EnumerateOutgoingJettonTransfersResult,
    networkGlobalId?: TonNetworkGlobalId,
  ) {
    this.result = result;
    this.networkGlobalId = networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
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
    return { ok: true, networkGlobalId: this.networkGlobalId, latencyMs: 1 };
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
    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
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

    const result = await collectPhase10ProviderBackedChainHistory(
      baseCollectInput(primary, secondary, []),
    );
    expect(result.completeCoverage).toBe(false);
    expect(result.reconciliationResult).toBe(PHASE10_CHAIN_HISTORY_INCOMPLETE);
    expect(result.enumerationAuthority).toBe('PROVIDER_BACKED');
  });

  it('evidence digest tamper → assertIntegrity fails', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const result = await collectPhase10ProviderBackedChainHistory(
      baseCollectInput(primary, secondary, []),
    );
    assertPhase10CollectorEvidenceIntegrity(result);

    const tampered = {
      ...result,
      collectorDigest: '0'.repeat(64),
      evidenceDigest: '0'.repeat(64),
    };
    expect(() => assertPhase10CollectorEvidenceIntegrity(tampered)).toThrow(/tamper|mismatch/i);

    const recomputed = digestPhase10CollectorEvidence(result);
    expect(recomputed).toBe(result.collectorDigest);
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
      collectPhase10ProviderBackedChainHistory(
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
      collectPhase10ProviderBackedChainHistory(
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
      collectPhase10ProviderBackedChainHistory(
        baseCollectInput(badMaster, new StubEnumerateProvider(completeEmptyResult('tonapi')), []),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*jettonMaster/);

    const badNetworkResult: EnumerateOutgoingJettonTransfersResult = {
      ...completeEmptyResult('toncenter'),
      networkGlobalId: -239,
    };
    // networkGlobalId on provider instance must be Testnet before enumeration.
    const badNetworkProvider = new StubEnumerateProvider(badNetworkResult, -239);
    await expect(
      collectPhase10ProviderBackedChainHistory(
        baseCollectInput(
          badNetworkProvider,
          new StubEnumerateProvider(completeEmptyResult('tonapi')),
          [],
        ),
      ),
    ).rejects.toThrow(/BINDING_REFUSED.*networkGlobalId/);
  });

  it('loadPhase10ExpectedCampaignPayouts rejects missing INTENDED_PAYOUT_PROVEN', async () => {
    const withdrawalId = randomUUID();
    const fakeDb = {
      query: async () => ({ rows: [] }),
    };
    await expect(
      loadPhase10ExpectedCampaignPayouts(fakeDb as never, [withdrawalId], WINDOW),
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
            resolved_at: new Date('2024-01-01T12:00:00.000Z'),
            recipient: RECIPIENT,
            net_amount_atomic: '1000',
            jetton_master: MASTER,
            attempt_query_id: '42',
            broadcasted_at: new Date('2024-01-01T11:00:00.000Z'),
          },
        ],
      }),
    };

    const payouts = await loadPhase10ExpectedCampaignPayouts(
      fakeDb as never,
      [withdrawalId],
      WINDOW,
    );
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
    });
  });
});
