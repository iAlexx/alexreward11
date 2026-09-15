/**
 * Phase 10 dual-provider Hot Wallet outgoing Jetton history collector.
 * Calls primary + secondary enumerateOutgoingJettonTransfers independently.
 * Never accepts caller-supplied transfer arrays. Fail closed on incomplete /
 * disagreement / binding mismatches. Acceptance remains gated by
 * PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE = false.
 *
 * Production entrypoint: collectPhase10LiveProviderBackedChainHistory
 * (TonCenter primary + TonAPI secondary, readiness fingerprints, health probes,
 * DB-loaded expected payouts via loadPhase10ExpectedCampaignPayouts).
 * Injectable dual-fake / fetchImpl paths are test-only and not exported from
 * package index.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  canonicalizeTonAddress,
  createTonChainProvider,
  type EnumerateOutgoingJettonTransfersResult,
  type EnumeratedOutgoingJettonTransfer,
  type TonChainProvider,
} from '@alex-rewards/ton';

import type { WithdrawalDb } from './db.js';
import {
  PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
  PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
  PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
  digestChainHistoryTransfers,
  type Phase10ChainHistoryEvidenceArtifact,
  type Phase10ChainHistoryOutgoingTransfer,
  type Phase10ChainHistoryReconciliationResult,
} from './phase10-chain-history-evidence.js';
import { fingerprintProviderEndpoint } from './phase10-live-probes.js';

export const PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION = '1.0.0' as const;

export const PHASE10_PROVIDER_HISTORY_DISAGREEMENT = 'PROVIDER_HISTORY_DISAGREEMENT' as const;
export const PHASE10_CHAIN_HISTORY_INCOMPLETE = 'CHAIN_HISTORY_INCOMPLETE' as const;
export const PHASE10_EXPECTED_CONFIRMED_OUTGOING = 'EXPECTED_CONFIRMED_OUTGOING' as const;
export const PHASE10_UNEXPECTED_OUTGOING = 'UNEXPECTED_OUTGOING' as const;
export const PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY =
  'EXPECTED_PAYOUT_MISSING_FROM_HISTORY' as const;
export const PHASE10_DUPLICATE_ECONOMIC_PAYOUT = 'DUPLICATE_ECONOMIC_PAYOUT' as const;
export const PHASE10_ZERO_UNEXPECTED = 'ZERO_UNEXPECTED' as const;

export type Phase10ChainHistoryCollectorReconciliationResult =
  | typeof PHASE10_PROVIDER_HISTORY_DISAGREEMENT
  | typeof PHASE10_CHAIN_HISTORY_INCOMPLETE
  | typeof PHASE10_EXPECTED_CONFIRMED_OUTGOING
  | typeof PHASE10_UNEXPECTED_OUTGOING
  | typeof PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY
  | typeof PHASE10_DUPLICATE_ECONOMIC_PAYOUT
  | typeof PHASE10_ZERO_UNEXPECTED;

export type Phase10ChainHistoryAgreementVerdict =
  | 'AGREED'
  | typeof PHASE10_PROVIDER_HISTORY_DISAGREEMENT
  | typeof PHASE10_CHAIN_HISTORY_INCOMPLETE
  | 'BINDING_REFUSED';

export interface Phase10ExpectedCampaignPayout {
  readonly withdrawalId: string;
  readonly attemptId: string | null;
  readonly queryId: string | null;
  readonly primaryTransactionIdentity: string | null;
  readonly secondaryTransactionIdentity: string | null;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly jettonMaster: string;
  /** Occurrence timestamp for observation-window membership (never resolved_at). */
  readonly intendedAt: string;
}

export interface Phase10ChainHistoryProviderCoverage {
  readonly providerKind: string;
  readonly pagesFetched: number;
  readonly recordsSeen: number;
  readonly cursorExhausted: boolean;
  readonly windowFullyCovered: boolean;
  readonly truncated: boolean;
  readonly oldestObservedTimestamp: string | null;
  readonly newestObservedTimestamp: string | null;
  readonly warnings: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
}

/** Shared dual-enumerate input used by the Live production path and ForTests. */
export interface CollectPhase10ProviderBackedChainHistoryForTestsInput {
  readonly campaignId: string;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  readonly jettonMaster: string;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly primary: TonChainProvider;
  readonly secondary: TonChainProvider;
  readonly primaryKind: string;
  readonly secondaryKind: string;
  readonly primaryEndpointFingerprint: string;
  readonly secondaryEndpointFingerprint: string;
  /** DB-derived expected payouts only — never freeform CLI identity JSON. */
  readonly expectedPayouts: readonly Phase10ExpectedCampaignPayout[];
  readonly collectionId?: string;
  readonly generatedAt?: string;
}

export interface Phase10LiveProviderEndpointConfig {
  /** Must be 'toncenter' (primary) or 'tonapi' (secondary); enforced at runtime. */
  readonly kind: string;
  readonly baseUrl: string;
  readonly apiKey?: string | null;
}

/**
 * Production collector input. Providers are constructed internally from
 * TonCenter (primary) + TonAPI (secondary) configs — never injectable fakes.
 * Expected payouts are loaded from DB; never caller-supplied arrays / fetchImpl.
 */
export interface CollectPhase10LiveProviderBackedChainHistoryInput {
  readonly db: WithdrawalDb;
  readonly campaignId: string;
  readonly campaignWithdrawalIds: readonly string[];
  /** Campaign createdAt ISO — withdrawals must have requested_at >= this. */
  readonly campaignCreatedAt: string;
  readonly controlledUserId: string;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  /** Passed to the DB loader as expectedJettonMaster. */
  readonly jettonMaster: string;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly primary: Phase10LiveProviderEndpointConfig;
  readonly secondary: Phase10LiveProviderEndpointConfig;
  /** Fingerprints from live readiness evidence — must match derived endpoints. */
  readonly readinessPrimaryEndpointFingerprint: string;
  readonly readinessSecondaryEndpointFingerprint: string;
  readonly collectionId?: string;
  readonly generatedAt?: string;
}

/** Test-only Live input: production shape plus optional fetchImpl injection. */
export interface CollectPhase10LiveProviderBackedChainHistoryForTestsInput extends CollectPhase10LiveProviderBackedChainHistoryInput {
  readonly fetchImpl?: typeof fetch;
}

export interface LoadPhase10ExpectedCampaignPayoutsInput {
  readonly campaignWithdrawalIds: readonly string[];
  readonly window: { readonly start: string; readonly end: string };
  /** Campaign createdAt ISO — withdrawals must have requested_at >= this. */
  readonly campaignCreatedAt: string;
  readonly expectedHotWalletAddress: string;
  readonly expectedJettonMaster: string;
  readonly controlledUserId: string;
}

export interface Phase10ChainHistoryCollectorArtifact {
  readonly schemaVersion: typeof PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly collectorVersion: typeof PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION;
  readonly collectionId: string;
  readonly networkCode: 'TON_TESTNET';
  readonly networkGlobalId: typeof PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  readonly jettonMaster: string;
  readonly campaignId: string;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly providerIdentity: {
    readonly primaryKind: string;
    readonly primaryEndpointFingerprint: string;
    readonly secondaryKind: string;
    readonly secondaryEndpointFingerprint: string;
    readonly independenceProven: boolean;
  };
  readonly primaryCoverage: Phase10ChainHistoryProviderCoverage;
  readonly secondaryCoverage: Phase10ChainHistoryProviderCoverage;
  readonly completeCoverage: boolean;
  readonly providerAgreement: boolean;
  readonly normalizedOutgoingTransfers: readonly Phase10ChainHistoryOutgoingTransfer[];
  readonly expectedPayouts: readonly Phase10ExpectedCampaignPayout[];
  readonly expectedPayoutIdentities: readonly string[];
  readonly matchedCount: number;
  readonly missingExpectedCount: number;
  readonly unexpectedOutgoingCount: number;
  readonly duplicateEconomicCount: number;
  readonly reconciliationResult: Phase10ChainHistoryCollectorReconciliationResult;
  readonly enumerationAuthority: 'PROVIDER_BACKED';
  readonly evidenceDigest: string;
  readonly collectorDigest: string;
  readonly notes: readonly string[];
  readonly primaryResult: EnumerateOutgoingJettonTransfersResult;
  readonly secondaryResult: EnumerateOutgoingJettonTransfersResult;
  readonly agreementVerdict: Phase10ChainHistoryAgreementVerdict;
}

function normalizeAddressLoose(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    return canonicalizeTonAddress(trimmed).rawAddress.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function addressesEqualLoose(left: string, right: string): boolean {
  return normalizeAddressLoose(left) === normalizeAddressLoose(right);
}

function queryIdPresentAndNonzero(queryId: string | null | undefined): queryId is string {
  if (queryId === null || queryId === undefined) return false;
  const trimmed = queryId.trim();
  return trimmed !== '' && trimmed !== '0';
}

/** Strongest available economic identity for an outgoing transfer or expected payout. */
export function buildPhase10EconomicKey(input: {
  readonly queryId: string | null;
  readonly amountAtomic: string;
  readonly recipient: string;
  readonly jettonMaster: string;
  readonly transactionHash?: string | null;
  readonly transactionLt?: string | null;
}): string {
  const amount = input.amountAtomic.trim();
  const recipient = normalizeAddressLoose(input.recipient);
  const master = normalizeAddressLoose(input.jettonMaster);
  if (queryIdPresentAndNonzero(input.queryId)) {
    return `${input.queryId.trim()}|${amount}|${recipient}|${master}`;
  }
  const hash = (input.transactionHash ?? '').trim();
  const lt = (input.transactionLt ?? '').trim();
  if (hash !== '' || lt !== '') {
    return `${hash}|${lt}|${amount}|${recipient}|${master}`;
  }
  return `|${amount}|${recipient}|${master}`;
}

function coverageFromResult(
  result: EnumerateOutgoingJettonTransfersResult,
): Phase10ChainHistoryProviderCoverage {
  return {
    providerKind: result.providerKind,
    pagesFetched: result.pagesFetched,
    recordsSeen: result.recordsSeen,
    cursorExhausted: result.cursorExhausted,
    windowFullyCovered: result.windowFullyCovered,
    truncated: result.truncated,
    oldestObservedTimestamp: result.oldestObservedTimestamp,
    newestObservedTimestamp: result.newestObservedTimestamp,
    warnings: [...result.warnings],
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
}

function toOutgoingTransfer(
  record: EnumeratedOutgoingJettonTransfer,
): Phase10ChainHistoryOutgoingTransfer {
  return {
    transferIdentity: record.transferIdentity,
    transactionHash: record.transactionHash,
    queryId: record.queryId,
    amountAtomic: record.amountAtomic,
    recipient: record.recipient,
    observedAt: record.timestamp,
    providerKind: record.providerKind,
  };
}

function flatExpectedIdentities(payouts: readonly Phase10ExpectedCampaignPayout[]): string[] {
  const ids = new Set<string>();
  for (const p of payouts) {
    if (queryIdPresentAndNonzero(p.queryId)) ids.add(p.queryId.trim());
    if (p.primaryTransactionIdentity?.trim()) ids.add(p.primaryTransactionIdentity.trim());
    if (p.secondaryTransactionIdentity?.trim()) ids.add(p.secondaryTransactionIdentity.trim());
    ids.add(
      buildPhase10EconomicKey({
        queryId: p.queryId,
        amountAtomic: p.amountAtomic,
        recipient: p.recipient,
        jettonMaster: p.jettonMaster,
        transactionHash: p.primaryTransactionIdentity ?? p.secondaryTransactionIdentity,
      }),
    );
  }
  return [...ids].sort();
}

function economicKeyFromTransfer(t: EnumeratedOutgoingJettonTransfer): string {
  return buildPhase10EconomicKey({
    queryId: t.queryId,
    amountAtomic: t.amountAtomic,
    recipient: t.recipient,
    jettonMaster: t.jettonMaster,
    transactionHash: t.transactionHash,
    transactionLt: t.transactionLt,
  });
}

function economicKeyFromExpected(p: Phase10ExpectedCampaignPayout): string {
  return buildPhase10EconomicKey({
    queryId: p.queryId,
    amountAtomic: p.amountAtomic,
    recipient: p.recipient,
    jettonMaster: p.jettonMaster,
    transactionHash: p.primaryTransactionIdentity ?? p.secondaryTransactionIdentity,
  });
}

function transferMatchesBinding(
  transfer: EnumeratedOutgoingJettonTransfer,
  input: CollectPhase10ProviderBackedChainHistoryForTestsInput,
): string | null {
  if (transfer.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
    return `transfer networkGlobalId must be ${PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID}`;
  }
  if (!addressesEqualLoose(transfer.hotWalletAddress, input.hotWalletAddress)) {
    return 'transfer hotWalletAddress does not match collector binding';
  }
  if (
    transfer.senderJettonWallet !== null &&
    !addressesEqualLoose(transfer.senderJettonWallet, input.hotWalletJettonWallet)
  ) {
    return 'transfer senderJettonWallet does not match collector binding';
  }
  if (!addressesEqualLoose(transfer.jettonMaster, input.jettonMaster)) {
    return 'transfer jettonMaster does not match collector binding';
  }
  return null;
}

function assertProviderBinding(
  result: EnumerateOutgoingJettonTransfersResult,
  input: CollectPhase10ProviderBackedChainHistoryForTestsInput,
  label: 'primary' | 'secondary',
): void {
  if (result.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
    throw new Error(
      `BINDING_REFUSED: ${label} provider networkGlobalId must be ${PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID} (got ${result.networkGlobalId})`,
    );
  }
  for (const transfer of result.transfers) {
    const reason = transferMatchesBinding(transfer, input);
    if (reason !== null) {
      throw new Error(`BINDING_REFUSED: ${label} ${reason}`);
    }
  }
}

function assertInputProviderNetworks(
  input: CollectPhase10ProviderBackedChainHistoryForTestsInput,
): void {
  if (input.primary.networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    throw new Error(
      `BINDING_REFUSED: primary provider networkGlobalId must be ${TON_TESTNET_NETWORK_GLOBAL_ID}`,
    );
  }
  if (input.secondary.networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    throw new Error(
      `BINDING_REFUSED: secondary provider networkGlobalId must be ${TON_TESTNET_NETWORK_GLOBAL_ID}`,
    );
  }
}

function assertExpectedPayoutSet(
  expectedPayouts: readonly Phase10ExpectedCampaignPayout[],
  window: { readonly start: string; readonly end: string },
): void {
  const byEconomic = new Map<string, Phase10ExpectedCampaignPayout>();
  const byQueryId = new Map<string, Phase10ExpectedCampaignPayout>();
  const windowStart = Date.parse(window.start);
  const windowEnd = Date.parse(window.end);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    throw new Error('REFUSE: observation window start/end is not a valid ISO timestamp');
  }

  for (const payout of expectedPayouts) {
    if (typeof payout.intendedAt !== 'string' || payout.intendedAt.trim() === '') {
      throw new Error(`REFUSE: expected payout ${payout.withdrawalId} intendedAt missing or empty`);
    }
    const at = Date.parse(payout.intendedAt);
    if (!Number.isFinite(at)) {
      throw new Error(`REFUSE: expected payout ${payout.withdrawalId} intendedAt is unparseable`);
    }
    if (at < windowStart || at > windowEnd) {
      throw new Error(
        `REFUSE: expected payout ${payout.withdrawalId} intendedAt outside observation window`,
      );
    }

    const economic = economicKeyFromExpected(payout);
    const priorEconomic = byEconomic.get(economic);
    if (priorEconomic !== undefined) {
      throw new Error(
        `duplicate economic identity across expected set (${economic}) for withdrawals ${priorEconomic.withdrawalId} and ${payout.withdrawalId}`,
      );
    }
    byEconomic.set(economic, payout);

    if (queryIdPresentAndNonzero(payout.queryId)) {
      const q = payout.queryId.trim();
      const prior = byQueryId.get(q);
      if (prior !== undefined) {
        if (
          !addressesEqualLoose(prior.recipient, payout.recipient) ||
          prior.amountAtomic.trim() !== payout.amountAtomic.trim()
        ) {
          throw new Error(
            `conflicting recipient/amount for same queryId ${q} across expected payouts`,
          );
        }
      } else {
        byQueryId.set(q, payout);
      }
    }
  }
}

function canonicalizeExpectedPayoutsForDigest(
  payouts: readonly Phase10ExpectedCampaignPayout[],
): ReadonlyArray<{
  readonly withdrawalId: string;
  readonly attemptId: string | null;
  readonly queryId: string | null;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly jettonMaster: string;
  readonly intendedAt: string;
}> {
  return [...payouts]
    .map((p) => ({
      withdrawalId: p.withdrawalId,
      attemptId: p.attemptId,
      queryId: p.queryId,
      recipient: normalizeAddressLoose(p.recipient),
      amountAtomic: p.amountAtomic.trim(),
      jettonMaster: normalizeAddressLoose(p.jettonMaster),
      intendedAt: p.intendedAt,
    }))
    .sort((a, b) => {
      const byWithdrawal = a.withdrawalId.localeCompare(b.withdrawalId);
      if (byWithdrawal !== 0) return byWithdrawal;
      const byAttempt = (a.attemptId ?? '').localeCompare(b.attemptId ?? '');
      if (byAttempt !== 0) return byAttempt;
      const byQuery = (a.queryId ?? '').localeCompare(b.queryId ?? '');
      if (byQuery !== 0) return byQuery;
      return a.amountAtomic.localeCompare(b.amountAtomic);
    });
}

/**
 * Canonical digest over collector safety-relevant fields (window, wallets,
 * providers, transfers, full expected payout set, reconciliation counts). No secrets.
 */
export function digestPhase10CollectorEvidence(payload: {
  readonly collectionId: string;
  readonly campaignId: string;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  readonly jettonMaster: string;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly providerIdentity: Phase10ChainHistoryCollectorArtifact['providerIdentity'];
  readonly normalizedOutgoingTransfers: readonly Phase10ChainHistoryOutgoingTransfer[];
  readonly expectedPayouts: readonly Phase10ExpectedCampaignPayout[];
  readonly matchedCount: number;
  readonly missingExpectedCount: number;
  readonly unexpectedOutgoingCount: number;
  readonly duplicateEconomicCount: number;
  readonly reconciliationResult: string;
  readonly completeCoverage: boolean;
  readonly providerAgreement: boolean;
}): string {
  const canonical = {
    collectionId: payload.collectionId,
    campaignId: payload.campaignId,
    hotWalletAddress: normalizeAddressLoose(payload.hotWalletAddress),
    hotWalletJettonWallet: normalizeAddressLoose(payload.hotWalletJettonWallet),
    jettonMaster: normalizeAddressLoose(payload.jettonMaster),
    observationWindow: payload.observationWindow,
    providerIdentity: payload.providerIdentity,
    transfers: [...payload.normalizedOutgoingTransfers]
      .map((t) => ({
        transferIdentity: t.transferIdentity,
        transactionHash: t.transactionHash,
        queryId: t.queryId,
        amountAtomic: t.amountAtomic,
        recipient: t.recipient === null ? null : normalizeAddressLoose(t.recipient),
        observedAt: t.observedAt,
        providerKind: t.providerKind,
      }))
      .sort((a, b) => a.transferIdentity.localeCompare(b.transferIdentity)),
    expectedPayouts: canonicalizeExpectedPayoutsForDigest(payload.expectedPayouts),
    matchedCount: payload.matchedCount,
    missingExpectedCount: payload.missingExpectedCount,
    unexpectedOutgoingCount: payload.unexpectedOutgoingCount,
    duplicateEconomicCount: payload.duplicateEconomicCount,
    reconciliationResult: payload.reconciliationResult,
    completeCoverage: payload.completeCoverage,
    providerAgreement: payload.providerAgreement,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function assertPhase10CollectorEvidenceIntegrity(
  artifact: Phase10ChainHistoryCollectorArtifact,
): void {
  const recomputed = digestPhase10CollectorEvidence({
    collectionId: artifact.collectionId,
    campaignId: artifact.campaignId,
    hotWalletAddress: artifact.hotWalletAddress,
    hotWalletJettonWallet: artifact.hotWalletJettonWallet,
    jettonMaster: artifact.jettonMaster,
    observationWindow: artifact.observationWindow,
    providerIdentity: artifact.providerIdentity,
    normalizedOutgoingTransfers: artifact.normalizedOutgoingTransfers,
    expectedPayouts: artifact.expectedPayouts,
    matchedCount: artifact.matchedCount,
    missingExpectedCount: artifact.missingExpectedCount,
    unexpectedOutgoingCount: artifact.unexpectedOutgoingCount,
    duplicateEconomicCount: artifact.duplicateEconomicCount,
    reconciliationResult: artifact.reconciliationResult,
    completeCoverage: artifact.completeCoverage,
    providerAgreement: artifact.providerAgreement,
  });
  if (recomputed !== artifact.collectorDigest || recomputed !== artifact.evidenceDigest) {
    throw new Error('collector evidenceDigest/collectorDigest mismatch (tamper or corruption)');
  }
}

function reconcileAgreedSet(
  agreed: readonly EnumeratedOutgoingJettonTransfer[],
  expectedPayouts: readonly Phase10ExpectedCampaignPayout[],
): {
  readonly matchedCount: number;
  readonly missingExpectedCount: number;
  readonly unexpectedOutgoingCount: number;
  readonly duplicateEconomicCount: number;
  readonly notes: string[];
} {
  const notes: string[] = [];
  const outgoingByKey = new Map<string, EnumeratedOutgoingJettonTransfer[]>();
  for (const t of agreed) {
    const key = economicKeyFromTransfer(t);
    const list = outgoingByKey.get(key) ?? [];
    list.push(t);
    outgoingByKey.set(key, list);
  }

  let matchedCount = 0;
  let missingExpectedCount = 0;
  let duplicateEconomicCount = 0;
  const matchedKeys = new Set<string>();

  for (const expected of expectedPayouts) {
    const key = economicKeyFromExpected(expected);
    const matches = outgoingByKey.get(key) ?? [];
    if (matches.length === 0) {
      missingExpectedCount += 1;
      notes.push(
        `${PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY}: withdrawalId=${expected.withdrawalId}`,
      );
    } else if (matches.length > 1) {
      duplicateEconomicCount += matches.length - 1;
      matchedCount += 1;
      matchedKeys.add(key);
      notes.push(
        `${PHASE10_DUPLICATE_ECONOMIC_PAYOUT}: economicKey=${key} matchCount=${matches.length}`,
      );
    } else {
      matchedCount += 1;
      matchedKeys.add(key);
      notes.push(`${PHASE10_EXPECTED_CONFIRMED_OUTGOING}: withdrawalId=${expected.withdrawalId}`);
    }
  }

  let unexpectedOutgoingCount = 0;
  for (const [key, transfers] of outgoingByKey) {
    if (!matchedKeys.has(key)) {
      // No expected payout claimed this key — each outgoing is unexpected.
      unexpectedOutgoingCount += transfers.length;
      for (const t of transfers) {
        notes.push(
          `${PHASE10_UNEXPECTED_OUTGOING}: transferIdentity=${t.transferIdentity} economicKey=${key}`,
        );
      }
    }
  }

  return {
    matchedCount,
    missingExpectedCount,
    unexpectedOutgoingCount,
    duplicateEconomicCount,
    notes,
  };
}

function overallReconciliation(input: {
  readonly completeCoverage: boolean;
  readonly providerAgreement: boolean;
  readonly duplicateEconomicCount: number;
  readonly missingExpectedCount: number;
  readonly unexpectedOutgoingCount: number;
}): Phase10ChainHistoryCollectorReconciliationResult {
  if (!input.completeCoverage) return PHASE10_CHAIN_HISTORY_INCOMPLETE;
  if (!input.providerAgreement) return PHASE10_PROVIDER_HISTORY_DISAGREEMENT;
  if (input.duplicateEconomicCount > 0) return PHASE10_DUPLICATE_ECONOMIC_PAYOUT;
  if (input.missingExpectedCount > 0) return PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY;
  if (input.unexpectedOutgoingCount > 0) return PHASE10_UNEXPECTED_OUTGOING;
  return PHASE10_ZERO_UNEXPECTED;
}

/**
 * Dual-provider coordinator: independently enumerate primary + secondary
 * outgoing Jetton history, compare economic sets, reconcile vs DB expected.
 * Input MUST NOT include providerEnumeratedOutgoingTransfers / caller arrays.
 *
 * Test-only injectable path — not exported from package index.
 */
export async function collectPhase10ProviderBackedChainHistoryForTests(
  input: CollectPhase10ProviderBackedChainHistoryForTestsInput,
): Promise<Phase10ChainHistoryCollectorArtifact> {
  return coordinateDualProviderEnumeration(input);
}

/**
 * Production collector: constructs TonCenter (primary) + TonAPI (secondary),
 * verifies readiness fingerprints + Testnet health, loads expected payouts from
 * DB, then dual-enumerates. Never accepts injectable provider fakes, fetchImpl,
 * or caller transfer / expectedPayout arrays.
 */
export async function collectPhase10LiveProviderBackedChainHistory(
  input: CollectPhase10LiveProviderBackedChainHistoryInput,
): Promise<Phase10ChainHistoryCollectorArtifact> {
  return runLiveProviderBackedCollection(input, undefined);
}

/**
 * Test-only Live collector: same production path with optional fetchImpl injection.
 * Not exported from package index.
 */
export async function collectPhase10LiveProviderBackedChainHistoryForTests(
  input: CollectPhase10LiveProviderBackedChainHistoryForTestsInput,
): Promise<Phase10ChainHistoryCollectorArtifact> {
  return runLiveProviderBackedCollection(input, input.fetchImpl);
}

async function runLiveProviderBackedCollection(
  input: CollectPhase10LiveProviderBackedChainHistoryInput,
  fetchImpl: typeof fetch | undefined,
): Promise<Phase10ChainHistoryCollectorArtifact> {
  if (input.primary.kind !== 'toncenter') {
    throw new Error(
      `BINDING_REFUSED: live primary.kind must be 'toncenter' (got ${input.primary.kind})`,
    );
  }
  if (input.secondary.kind !== 'tonapi') {
    throw new Error(
      `BINDING_REFUSED: live secondary.kind must be 'tonapi' (got ${input.secondary.kind})`,
    );
  }

  const primaryFingerprint = fingerprintProviderEndpoint(input.primary.baseUrl);
  const secondaryFingerprint = fingerprintProviderEndpoint(input.secondary.baseUrl);
  if (primaryFingerprint === null || secondaryFingerprint === null) {
    throw new Error('BINDING_REFUSED: unable to derive provider endpoint fingerprints');
  }
  if (primaryFingerprint !== input.readinessPrimaryEndpointFingerprint.trim()) {
    throw new Error(
      'BINDING_REFUSED: primary endpoint fingerprint does not match readiness evidence',
    );
  }
  if (secondaryFingerprint !== input.readinessSecondaryEndpointFingerprint.trim()) {
    throw new Error(
      'BINDING_REFUSED: secondary endpoint fingerprint does not match readiness evidence',
    );
  }
  if (primaryFingerprint === secondaryFingerprint) {
    throw new Error('BINDING_REFUSED: primary and secondary endpoint fingerprints must differ');
  }

  const primary = createTonChainProvider({
    kind: 'toncenter',
    baseUrl: input.primary.baseUrl,
    ...(input.primary.apiKey !== undefined ? { apiKey: input.primary.apiKey } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const secondary = createTonChainProvider({
    kind: 'tonapi',
    baseUrl: input.secondary.baseUrl,
    ...(input.secondary.apiKey !== undefined ? { apiKey: input.secondary.apiKey } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  const [primaryHealth, secondaryHealth] = await Promise.all([
    primary.health(),
    secondary.health(),
  ]);
  if (
    !primaryHealth.ok ||
    primaryHealth.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID
  ) {
    throw new Error(
      `BINDING_REFUSED: primary TonCenter health must be ok on Testnet (ok=${primaryHealth.ok}, networkGlobalId=${primaryHealth.networkGlobalId})`,
    );
  }
  if (
    !secondaryHealth.ok ||
    secondaryHealth.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID
  ) {
    throw new Error(
      `BINDING_REFUSED: secondary TonAPI health must be ok on Testnet (ok=${secondaryHealth.ok}, networkGlobalId=${secondaryHealth.networkGlobalId})`,
    );
  }

  const expectedPayouts = await loadPhase10ExpectedCampaignPayouts(input.db, {
    campaignWithdrawalIds: input.campaignWithdrawalIds,
    window: input.observationWindow,
    campaignCreatedAt: input.campaignCreatedAt,
    expectedHotWalletAddress: input.hotWalletAddress,
    expectedJettonMaster: input.jettonMaster,
    controlledUserId: input.controlledUserId,
  });

  return coordinateDualProviderEnumeration({
    campaignId: input.campaignId,
    hotWalletAddress: input.hotWalletAddress,
    hotWalletJettonWallet: input.hotWalletJettonWallet,
    jettonMaster: input.jettonMaster,
    observationWindow: input.observationWindow,
    primary,
    secondary,
    primaryKind: 'toncenter',
    secondaryKind: 'tonapi',
    primaryEndpointFingerprint: primaryFingerprint,
    secondaryEndpointFingerprint: secondaryFingerprint,
    expectedPayouts,
    ...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
    ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
  });
}

async function coordinateDualProviderEnumeration(
  input: CollectPhase10ProviderBackedChainHistoryForTestsInput,
): Promise<Phase10ChainHistoryCollectorArtifact> {
  assertInputProviderNetworks(input);
  assertExpectedPayoutSet(input.expectedPayouts, input.observationWindow);

  const collectionId = input.collectionId?.trim() || randomUUID();
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const independenceProven =
    input.primaryKind.trim() !== '' &&
    input.secondaryKind.trim() !== '' &&
    input.primaryKind !== input.secondaryKind &&
    input.primaryEndpointFingerprint.trim() !== '' &&
    input.secondaryEndpointFingerprint.trim() !== '' &&
    input.primaryEndpointFingerprint !== input.secondaryEndpointFingerprint;

  const enumerateInput = {
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet.trim(),
    jettonMaster: input.jettonMaster.trim(),
    windowStart: input.observationWindow.start,
    windowEnd: input.observationWindow.end,
  };

  // Independent dual enumeration — never accept caller transfer arrays.
  const [primaryResult, secondaryResult] = await Promise.all([
    input.primary.enumerateOutgoingJettonTransfers(enumerateInput),
    input.secondary.enumerateOutgoingJettonTransfers(enumerateInput),
  ]);

  assertProviderBinding(primaryResult, input, 'primary');
  assertProviderBinding(secondaryResult, input, 'secondary');

  const primaryCoverage = coverageFromResult(primaryResult);
  const secondaryCoverage = coverageFromResult(secondaryResult);
  const completeCoverage =
    primaryCoverage.windowFullyCovered &&
    secondaryCoverage.windowFullyCovered &&
    !primaryCoverage.truncated &&
    !secondaryCoverage.truncated;

  const notes: string[] = [];
  if (!completeCoverage) {
    notes.push(
      `${PHASE10_CHAIN_HISTORY_INCOMPLETE}: primary windowFullyCovered=${primaryCoverage.windowFullyCovered} truncated=${primaryCoverage.truncated}; secondary windowFullyCovered=${secondaryCoverage.windowFullyCovered} truncated=${secondaryCoverage.truncated}`,
    );
  }

  const primaryByKey = new Map<string, EnumeratedOutgoingJettonTransfer[]>();
  for (const t of primaryResult.transfers) {
    const key = economicKeyFromTransfer(t);
    const list = primaryByKey.get(key) ?? [];
    list.push(t);
    primaryByKey.set(key, list);
  }
  const secondaryByKey = new Map<string, EnumeratedOutgoingJettonTransfer[]>();
  for (const t of secondaryResult.transfers) {
    const key = economicKeyFromTransfer(t);
    const list = secondaryByKey.get(key) ?? [];
    list.push(t);
    secondaryByKey.set(key, list);
  }

  let providerAgreement = false;
  let agreementVerdict: Phase10ChainHistoryAgreementVerdict = PHASE10_CHAIN_HISTORY_INCOMPLETE;
  let agreedTransfers: EnumeratedOutgoingJettonTransfer[] = [];

  if (completeCoverage) {
    const allKeys = new Set([...primaryByKey.keys(), ...secondaryByKey.keys()]);
    let multisetDisagree = false;
    let onlyPrimary = 0;
    let onlySecondary = 0;
    for (const key of allKeys) {
      const primaryCount = primaryByKey.get(key)?.length ?? 0;
      const secondaryCount = secondaryByKey.get(key)?.length ?? 0;
      if (primaryCount !== secondaryCount) {
        multisetDisagree = true;
        if (secondaryCount === 0) onlyPrimary += primaryCount;
        else if (primaryCount === 0) onlySecondary += secondaryCount;
      }
    }
    if (multisetDisagree) {
      providerAgreement = false;
      agreementVerdict = PHASE10_PROVIDER_HISTORY_DISAGREEMENT;
      notes.push(
        `${PHASE10_PROVIDER_HISTORY_DISAGREEMENT}: onlyPrimary=${onlyPrimary} onlySecondary=${onlySecondary} (economic multiset mismatch)`,
      );
      agreedTransfers = [];
    } else {
      providerAgreement = true;
      agreementVerdict = 'AGREED';
      agreedTransfers = [...primaryResult.transfers].sort((a, b) =>
        a.transferIdentity.localeCompare(b.transferIdentity),
      );
      notes.push('provider economic outgoing sets agree');
    }
  }

  const normalizedOutgoingTransfers =
    providerAgreement && completeCoverage ? agreedTransfers.map(toOutgoingTransfer) : [];

  const recon =
    providerAgreement && completeCoverage
      ? reconcileAgreedSet(agreedTransfers, input.expectedPayouts)
      : {
          matchedCount: 0,
          missingExpectedCount: 0,
          unexpectedOutgoingCount: 0,
          duplicateEconomicCount: 0,
          notes: [] as string[],
        };
  notes.push(...recon.notes);

  const reconciliationResult = overallReconciliation({
    completeCoverage,
    providerAgreement,
    duplicateEconomicCount: recon.duplicateEconomicCount,
    missingExpectedCount: recon.missingExpectedCount,
    unexpectedOutgoingCount: recon.unexpectedOutgoingCount,
  });

  const expectedPayoutIdentities = flatExpectedIdentities(input.expectedPayouts);
  const providerIdentity = {
    primaryKind: input.primaryKind,
    primaryEndpointFingerprint: input.primaryEndpointFingerprint,
    secondaryKind: input.secondaryKind,
    secondaryEndpointFingerprint: input.secondaryEndpointFingerprint,
    independenceProven,
  };

  const digestPayload = {
    collectionId,
    campaignId: input.campaignId,
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet.trim(),
    jettonMaster: input.jettonMaster.trim(),
    observationWindow: {
      start: input.observationWindow.start,
      end: input.observationWindow.end,
    },
    providerIdentity,
    normalizedOutgoingTransfers,
    expectedPayouts: input.expectedPayouts,
    matchedCount: recon.matchedCount,
    missingExpectedCount: recon.missingExpectedCount,
    unexpectedOutgoingCount: recon.unexpectedOutgoingCount,
    duplicateEconomicCount: recon.duplicateEconomicCount,
    reconciliationResult,
    completeCoverage,
    providerAgreement,
  };
  const collectorDigest = digestPhase10CollectorEvidence(digestPayload);

  return {
    schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    collectorVersion: PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION,
    collectionId,
    networkCode: 'TON_TESTNET',
    networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet.trim(),
    jettonMaster: input.jettonMaster.trim(),
    campaignId: input.campaignId,
    observationWindow: {
      start: input.observationWindow.start,
      end: input.observationWindow.end,
    },
    providerIdentity,
    primaryCoverage,
    secondaryCoverage,
    completeCoverage,
    providerAgreement,
    normalizedOutgoingTransfers,
    expectedPayouts: [...input.expectedPayouts],
    expectedPayoutIdentities,
    matchedCount: recon.matchedCount,
    missingExpectedCount: recon.missingExpectedCount,
    unexpectedOutgoingCount: recon.unexpectedOutgoingCount,
    duplicateEconomicCount: recon.duplicateEconomicCount,
    reconciliationResult,
    // Both providers were independently invoked after Live probes (when via Live API).
    enumerationAuthority: 'PROVIDER_BACKED',
    evidenceDigest: collectorDigest,
    collectorDigest,
    notes,
    primaryResult,
    secondaryResult,
    agreementVerdict,
  };
}

function mapCollectorReconciliationToEvidence(
  result: Phase10ChainHistoryCollectorReconciliationResult,
): Phase10ChainHistoryReconciliationResult {
  if (result === PHASE10_ZERO_UNEXPECTED) return 'ZERO_UNEXPECTED';
  if (result === PHASE10_UNEXPECTED_OUTGOING) return 'UNEXPECTED_OUTGOING';
  return PHASE10_CHAIN_HISTORY_PROOF_REQUIRED;
}

/**
 * Convert collector artifact to acceptance-shaped evidence.
 * evidenceDigest uses transfer digest for evaluateChainHistoryForAcceptance compat.
 * Collector integrity remains on collectorDigest / assertPhase10CollectorEvidenceIntegrity.
 */
export function toPhase10ChainHistoryEvidenceArtifact(
  collectorResult: Phase10ChainHistoryCollectorArtifact,
): Phase10ChainHistoryEvidenceArtifact {
  const outgoing = [...collectorResult.normalizedOutgoingTransfers];
  return {
    schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
    generatedAt: collectorResult.generatedAt,
    hotWalletAddress: collectorResult.hotWalletAddress,
    hotWalletJettonWallet: collectorResult.hotWalletJettonWallet,
    networkCode: 'TON_TESTNET',
    networkGlobalId: collectorResult.networkGlobalId,
    jettonMaster: collectorResult.jettonMaster,
    observationWindow: collectorResult.observationWindow,
    providerIdentity: collectorResult.providerIdentity,
    outgoingTransfers: outgoing,
    expectedCampaignPayoutIdentities: [...collectorResult.expectedPayoutIdentities],
    unexpectedOutgoingCount: collectorResult.unexpectedOutgoingCount,
    reconciliationResult: mapCollectorReconciliationToEvidence(
      collectorResult.reconciliationResult,
    ),
    enumerationAuthority: collectorResult.enumerationAuthority,
    notes: [
      ...collectorResult.notes,
      `collectorVersion=${collectorResult.collectorVersion}`,
      `collectionId=${collectorResult.collectionId}`,
      `collectorDigest=${collectorResult.collectorDigest}`,
      `collectorReconciliationResult=${collectorResult.reconciliationResult}`,
    ],
    evidenceDigest: digestChainHistoryTransfers(outgoing),
  };
}

function readEvidenceString(summary: unknown, ...keys: string[]): string | null {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const record = summary as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function isoFromDbTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value.trim();
  }
  return null;
}

function readEvidenceChainTimestamp(summary: unknown): string | null {
  const asIso = readEvidenceString(summary, 'observedAt', 'chainTimestamp', 'utime');
  if (asIso === null) return null;
  // utime may be a unix-seconds string.
  if (/^\d+$/.test(asIso)) {
    const seconds = Number(asIso);
    if (Number.isFinite(seconds) && seconds > 1_000_000_000) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return isoFromDbTimestamp(asIso);
}

/**
 * Load DB-derived expected campaign payouts for INTENDED_PAYOUT_PROVEN rows only.
 * Rejects missing durable proofs, duplicate economic identities, conflicting
 * queryId bindings, and intendedAt outside the observation window.
 *
 * intendedAt priority (never resolved_at for window membership):
 * 1. att.broadcast_submitted_at
 * 2. w.broadcasted_at
 * 3. chain timestamp from evidence_summary (observedAt / chainTimestamp / utime)
 * If all missing → REFUSE (do not set null).
 */
export async function loadPhase10ExpectedCampaignPayouts(
  db: WithdrawalDb,
  input: LoadPhase10ExpectedCampaignPayoutsInput,
): Promise<readonly Phase10ExpectedCampaignPayout[]> {
  const campaignWithdrawalIds = input.campaignWithdrawalIds;
  const window = input.window;
  if (campaignWithdrawalIds.length === 0) {
    return [];
  }

  const campaignCreatedAt = new Date(input.campaignCreatedAt);
  if (!Number.isFinite(campaignCreatedAt.getTime())) {
    throw new Error('MALFORMED_INPUT: campaignCreatedAt is not a valid ISO timestamp');
  }

  const controlledUserId = input.controlledUserId.trim();
  const expectedJettonMaster = input.expectedJettonMaster.trim();
  if (controlledUserId === '') {
    throw new Error('MALFORMED_INPUT: controlledUserId is required');
  }
  if (expectedJettonMaster === '') {
    throw new Error('MALFORMED_INPUT: expectedJettonMaster is required');
  }

  const params: unknown[] = [
    campaignWithdrawalIds,
    campaignCreatedAt.toISOString(),
    input.expectedHotWalletAddress.trim(),
    expectedJettonMaster,
    controlledUserId,
  ];

  const proofs = await db.query<{
    withdrawal_id: string;
    attempt_id: string | null;
    observed_query_id: string | null;
    correlation_reference: string | null;
    observed_recipient: string | null;
    observed_amount_atomic: string | null;
    evidence_summary: unknown;
    resolved_at: Date | string | null;
    recipient: string | null;
    net_amount_atomic: string;
    jetton_master: string | null;
    attempt_query_id: string | null;
    broadcasted_at: Date | string | null;
    broadcast_submitted_at: Date | string | null;
    requested_at: Date | string | null;
    hot_wallet_address: string | null;
  }>(
    `SELECT w.id::text AS withdrawal_id,
            r.withdrawal_attempt_id::text AS attempt_id,
            r.observed_query_id::text AS observed_query_id,
            r.correlation_reference,
            r.observed_recipient,
            r.observed_amount_atomic::text AS observed_amount_atomic,
            r.evidence_summary,
            r.resolved_at,
            COALESCE(uw.raw_address, uw.friendly_address) AS recipient,
            w.net_amount_atomic::text AS net_amount_atomic,
            a.contract_identity AS jetton_master,
            att.query_id::text AS attempt_query_id,
            w.broadcasted_at,
            att.broadcast_submitted_at,
            w.requested_at,
            hw.address AS hot_wallet_address
     FROM withdrawal_payout_reconciliations r
     JOIN withdrawals w ON w.id = r.withdrawal_id
     JOIN user_wallets uw ON uw.id = w.wallet_id
     JOIN assets a ON a.id = w.asset_id
     JOIN networks n ON n.id = w.network_id
     LEFT JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
     LEFT JOIN withdrawal_attempts att ON att.id = r.withdrawal_attempt_id
     WHERE w.id = ANY($1::uuid[])
       AND r.resolution = 'INTENDED_PAYOUT_PROVEN'
       AND w.requested_at >= $2::timestamptz
       AND n.code = 'TON_TESTNET'
       AND a.symbol = 'USDT'
       AND hw.address IS NOT NULL
       AND lower(trim(hw.address)) = lower(trim($3::text))
       AND a.contract_identity = $4
       AND w.user_id = $5::uuid
     ORDER BY r.resolved_at ASC NULLS LAST, r.id ASC`,
    params,
  );

  const provenWithdrawalIds = new Set(proofs.rows.map((row) => row.withdrawal_id));
  for (const withdrawalId of campaignWithdrawalIds) {
    if (!provenWithdrawalIds.has(withdrawalId)) {
      throw new Error(
        `payout without durable INTENDED_PAYOUT_PROVEN: withdrawalId=${withdrawalId}`,
      );
    }
  }

  const payouts: Phase10ExpectedCampaignPayout[] = proofs.rows.map((row) => {
    const queryId = row.observed_query_id ?? row.attempt_query_id ?? null;
    const recipient = row.observed_recipient?.trim() || row.recipient?.trim() || '';
    const amountAtomic = row.observed_amount_atomic?.trim() || row.net_amount_atomic.trim();
    const jettonMaster =
      row.jetton_master?.trim() ||
      readEvidenceString(row.evidence_summary, 'jettonMaster', 'jetton_master') ||
      '';
    if (recipient === '' || amountAtomic === '' || jettonMaster === '') {
      throw new Error(
        `INTENDED_PAYOUT_PROVEN row missing recipient/amount/jettonMaster for withdrawalId=${row.withdrawal_id}`,
      );
    }
    const primaryTransactionIdentity =
      readEvidenceString(
        row.evidence_summary,
        'primaryTransactionIdentity',
        'primaryTransactionHash',
        'primaryProofIdentity',
        'txIdentity',
        'transactionHash',
        'hotWalletTxHash',
      ) ??
      (typeof row.correlation_reference === 'string' && row.correlation_reference.trim() !== ''
        ? row.correlation_reference.trim()
        : null);
    const secondaryTransactionIdentity = readEvidenceString(
      row.evidence_summary,
      'secondaryTransactionIdentity',
      'secondaryTransactionHash',
      'secondaryProofIdentity',
    );
    // NEVER use resolved_at for observation-window membership.
    const intendedAt =
      isoFromDbTimestamp(row.broadcast_submitted_at) ??
      isoFromDbTimestamp(row.broadcasted_at) ??
      readEvidenceChainTimestamp(row.evidence_summary);
    if (intendedAt === null || intendedAt.trim() === '') {
      throw new Error(
        `REFUSE: expected payout ${row.withdrawal_id} missing occurrence timestamp (broadcast_submitted_at / broadcasted_at / chain evidence)`,
      );
    }

    return {
      withdrawalId: row.withdrawal_id,
      attemptId: row.attempt_id,
      queryId,
      primaryTransactionIdentity,
      secondaryTransactionIdentity,
      recipient,
      amountAtomic,
      jettonMaster,
      intendedAt,
    };
  });

  assertExpectedPayoutSet(payouts, window);
  return payouts;
}
