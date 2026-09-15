/**
 * Phase 10 live READ-ONLY dual-provider Hot Wallet outgoing Jetton history
 * validation. Validation-ONLY — never acceptance evidence.
 *
 * Schema is distinct from Phase10ChainHistoryEvidenceArtifact.
 * PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE remains false forever.
 *
 * Production: runPhase10ChainHistoryReadonlyValidate (constructs providers).
 * Test-only: runPhase10ChainHistoryReadonlyValidateForTests (injectable
 * providers / fetchImpl) — not exported from package index.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createTonChainProvider,
  type EnumerateOutgoingJettonTransfersResult,
  type EnumeratedOutgoingJettonTransfer,
  type TonChainProvider,
  type TonProviderHealth,
} from '@alex-rewards/ton';

import type { WithdrawalDb } from './db.js';
import {
  buildPhase10EconomicKey,
  type Phase10LiveProviderEndpointConfig,
} from './phase10-chain-history-collector.js';
import { PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID } from './phase10-chain-history-evidence.js';
import {
  loadPhase10AuthoritativeHotWalletIdentity,
  type Phase10AuthoritativeHotWalletIdentity,
} from './phase10-hot-wallet-identity.js';
import { fingerprintProviderEndpoint } from './phase10-live-probes.js';

export const PHASE10_READONLY_VALIDATION_SCHEMA_VERSION = 1 as const;

export type Phase10ReadonlyValidationVerdict =
  | 'PASS_WITH_OBSERVED_TRANSFERS'
  | 'PASS_ZERO_OUTGOING'
  | 'FAIL_PROVIDER_DISAGREEMENT'
  | 'FAIL_INCOMPLETE_HISTORY'
  | 'FAIL_PROVIDER_HEALTH'
  | 'FAIL_BINDING';

export interface Phase10ReadonlyValidationHealth {
  readonly ok: boolean;
  readonly networkGlobalId: number | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
}

export interface Phase10ReadonlyValidationCoverage {
  readonly pagesFetched: number;
  readonly recordsSeen: number;
  readonly cursorExhausted: boolean;
  readonly windowFullyCovered: boolean;
  readonly truncated: boolean;
  readonly oldestObservedTimestamp: string | null;
  readonly newestObservedTimestamp: string | null;
  readonly transferCount: number;
  readonly warnings: readonly string[];
}

export interface Phase10ReadonlyValidationAgreedTransfer {
  readonly queryId: string | null;
  readonly amountAtomic: string;
  readonly recipient: string;
  readonly transactionHash: string | null;
  readonly transactionLt: string | null;
  readonly timestamp: string;
}

export interface Phase10ReadonlyValidationReport {
  readonly schemaVersion: typeof PHASE10_READONLY_VALIDATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly validationOnly: true;
  readonly acceptanceEnabled: false;
  readonly networkCode: 'TON_TESTNET';
  readonly networkGlobalId: typeof PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  readonly jettonMaster: string;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly primaryProviderFingerprint: string;
  readonly secondaryProviderFingerprint: string;
  readonly primaryHealth: Phase10ReadonlyValidationHealth;
  readonly secondaryHealth: Phase10ReadonlyValidationHealth;
  readonly primaryCoverage: Phase10ReadonlyValidationCoverage;
  readonly secondaryCoverage: Phase10ReadonlyValidationCoverage;
  readonly providerAgreement: boolean;
  readonly agreedTransferCount: number;
  readonly onlyPrimaryCount: number;
  readonly onlySecondaryCount: number;
  readonly agreedTransfers: readonly Phase10ReadonlyValidationAgreedTransfer[];
  readonly verdict: Phase10ReadonlyValidationVerdict;
  readonly notes: readonly string[];
  readonly reportDigest: string;
}

export interface RunPhase10ChainHistoryReadonlyValidateInput {
  readonly db: WithdrawalDb;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly primary: Phase10LiveProviderEndpointConfig;
  readonly secondary: Phase10LiveProviderEndpointConfig;
  readonly jettonMaster: string;
  readonly networkCode: string;
  readonly realChainEnabled: boolean;
  readonly fakeChainEnabled: boolean;
  readonly generatedAt?: string;
}

/** Test-only input — not exported from package index. */
export interface RunPhase10ChainHistoryReadonlyValidateForTestsInput extends RunPhase10ChainHistoryReadonlyValidateInput {
  readonly primaryProvider?: TonChainProvider;
  readonly secondaryProvider?: TonChainProvider;
  readonly fetchImpl?: typeof fetch;
  /** When set, skips DB identity load (including explicit null → FAIL_BINDING). */
  readonly identityOverride?: Phase10AuthoritativeHotWalletIdentity | null;
}

const EMPTY_HEALTH: Phase10ReadonlyValidationHealth = {
  ok: false,
  networkGlobalId: null,
  latencyMs: null,
  detail: null,
};

const EMPTY_COVERAGE: Phase10ReadonlyValidationCoverage = {
  pagesFetched: 0,
  recordsSeen: 0,
  cursorExhausted: false,
  windowFullyCovered: false,
  truncated: false,
  oldestObservedTimestamp: null,
  newestObservedTimestamp: null,
  transferCount: 0,
  warnings: [],
};

function canonicalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForDigest);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeForDigest(record[key]);
    }
    return sorted;
  }
  return value;
}

export function digestPhase10ReadonlyValidationReport(
  reportWithoutDigest: Omit<Phase10ReadonlyValidationReport, 'reportDigest'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(reportWithoutDigest)))
    .digest('hex');
}

export function assertPhase10ReadonlyValidationReportIntegrity(
  report: Phase10ReadonlyValidationReport,
): void {
  const { reportDigest: _omit, ...withoutDigest } = report;
  void _omit;
  const recomputed = digestPhase10ReadonlyValidationReport(withoutDigest);
  if (recomputed !== report.reportDigest) {
    throw new Error('readonly validation reportDigest mismatch (tamper or corruption)');
  }
}

function isReadonlyValidationVerdict(value: unknown): value is Phase10ReadonlyValidationVerdict {
  return (
    value === 'PASS_WITH_OBSERVED_TRANSFERS' ||
    value === 'PASS_ZERO_OUTGOING' ||
    value === 'FAIL_PROVIDER_DISAGREEMENT' ||
    value === 'FAIL_INCOMPLETE_HISTORY' ||
    value === 'FAIL_PROVIDER_HEALTH' ||
    value === 'FAIL_BINDING'
  );
}

function isHealthShape(value: unknown): value is Phase10ReadonlyValidationHealth {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.ok === 'boolean' &&
    (h.networkGlobalId === null || typeof h.networkGlobalId === 'number') &&
    (h.latencyMs === null || typeof h.latencyMs === 'number') &&
    (h.detail === null || typeof h.detail === 'string')
  );
}

function isCoverageShape(value: unknown): value is Phase10ReadonlyValidationCoverage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.pagesFetched === 'number' &&
    typeof c.recordsSeen === 'number' &&
    typeof c.cursorExhausted === 'boolean' &&
    typeof c.windowFullyCovered === 'boolean' &&
    typeof c.truncated === 'boolean' &&
    (c.oldestObservedTimestamp === null || typeof c.oldestObservedTimestamp === 'string') &&
    (c.newestObservedTimestamp === null || typeof c.newestObservedTimestamp === 'string') &&
    typeof c.transferCount === 'number' &&
    Array.isArray(c.warnings)
  );
}

export function parsePhase10ReadonlyValidationReport(raw: unknown): {
  readonly errors: readonly string[];
  readonly parsed: Phase10ReadonlyValidationReport | null;
} {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['readonly validation report is not a JSON object'], parsed: null };
  }
  const root = raw as Record<string, unknown>;
  if (root.validationOnly !== true) {
    errors.push('readonly validation report validationOnly must be true');
  }
  if (root.acceptanceEnabled !== false) {
    errors.push('readonly validation report acceptanceEnabled must be false');
  }
  if (root.schemaVersion !== PHASE10_READONLY_VALIDATION_SCHEMA_VERSION) {
    errors.push('readonly validation report schemaVersion must be 1');
  }
  if (root.networkCode !== 'TON_TESTNET') {
    errors.push('readonly validation report networkCode must be TON_TESTNET');
  }
  if (root.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
    errors.push('readonly validation report networkGlobalId must be -3');
  }
  if (typeof root.generatedAt !== 'string' || root.generatedAt.trim() === '') {
    errors.push('readonly validation report missing generatedAt');
  }
  if (typeof root.hotWalletAddress !== 'string') {
    errors.push('readonly validation report missing hotWalletAddress');
  }
  if (typeof root.hotWalletJettonWallet !== 'string') {
    errors.push('readonly validation report missing hotWalletJettonWallet');
  }
  if (typeof root.jettonMaster !== 'string' || root.jettonMaster.trim() === '') {
    errors.push('readonly validation report missing jettonMaster');
  }
  const window =
    root.observationWindow !== null && typeof root.observationWindow === 'object'
      ? (root.observationWindow as Record<string, unknown>)
      : null;
  if (
    window === null ||
    typeof window.start !== 'string' ||
    typeof window.end !== 'string' ||
    window.start.trim() === '' ||
    window.end.trim() === ''
  ) {
    errors.push('readonly validation report missing observationWindow.start/end');
  }
  if (typeof root.primaryProviderFingerprint !== 'string') {
    errors.push('readonly validation report missing primaryProviderFingerprint');
  }
  if (typeof root.secondaryProviderFingerprint !== 'string') {
    errors.push('readonly validation report missing secondaryProviderFingerprint');
  }
  if (!isHealthShape(root.primaryHealth) || !isHealthShape(root.secondaryHealth)) {
    errors.push('readonly validation report missing primaryHealth/secondaryHealth');
  }
  if (!isCoverageShape(root.primaryCoverage) || !isCoverageShape(root.secondaryCoverage)) {
    errors.push('readonly validation report missing primaryCoverage/secondaryCoverage');
  }
  if (typeof root.providerAgreement !== 'boolean') {
    errors.push('readonly validation report missing providerAgreement');
  }
  if (typeof root.agreedTransferCount !== 'number') {
    errors.push('readonly validation report missing agreedTransferCount');
  }
  if (typeof root.onlyPrimaryCount !== 'number' || typeof root.onlySecondaryCount !== 'number') {
    errors.push('readonly validation report missing onlyPrimaryCount/onlySecondaryCount');
  }
  if (!Array.isArray(root.agreedTransfers)) {
    errors.push('readonly validation report missing agreedTransfers array');
  }
  if (!isReadonlyValidationVerdict(root.verdict)) {
    errors.push('readonly validation report verdict invalid');
  }
  if (!Array.isArray(root.notes)) {
    errors.push('readonly validation report missing notes array');
  }
  if (typeof root.reportDigest !== 'string' || root.reportDigest.trim() === '') {
    errors.push('readonly validation report missing reportDigest');
  }

  if (errors.length > 0) {
    return { errors, parsed: null };
  }

  const parsed = root as unknown as Phase10ReadonlyValidationReport;
  try {
    assertPhase10ReadonlyValidationReportIntegrity(parsed);
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      parsed: null,
    };
  }
  return { errors: [], parsed };
}

export async function writePhase10ReadonlyValidationReport(
  path: string,
  report: Phase10ReadonlyValidationReport,
): Promise<void> {
  assertPhase10ReadonlyValidationReportIntegrity(report);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function mapHealth(health: TonProviderHealth | null): Phase10ReadonlyValidationHealth {
  if (health === null) return EMPTY_HEALTH;
  return {
    ok: health.ok,
    networkGlobalId: health.networkGlobalId ?? null,
    latencyMs: health.latencyMs ?? null,
    detail: health.detail ?? null,
  };
}

function coverageFromResult(
  result: EnumerateOutgoingJettonTransfersResult | null,
): Phase10ReadonlyValidationCoverage {
  if (result === null) return EMPTY_COVERAGE;
  return {
    pagesFetched: result.pagesFetched,
    recordsSeen: result.recordsSeen,
    cursorExhausted: result.cursorExhausted,
    windowFullyCovered: result.windowFullyCovered,
    truncated: result.truncated,
    oldestObservedTimestamp: result.oldestObservedTimestamp,
    newestObservedTimestamp: result.newestObservedTimestamp,
    transferCount: result.transfers.length,
    warnings: [...result.warnings],
  };
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

function toAgreedTransfer(
  record: EnumeratedOutgoingJettonTransfer,
): Phase10ReadonlyValidationAgreedTransfer {
  return {
    queryId: record.queryId,
    amountAtomic: record.amountAtomic,
    recipient: record.recipient,
    transactionHash: record.transactionHash,
    transactionLt: record.transactionLt,
    timestamp: record.timestamp,
  };
}

function normalizeProviderKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function finishReport(
  partial: Omit<Phase10ReadonlyValidationReport, 'reportDigest'>,
): Phase10ReadonlyValidationReport {
  const reportDigest = digestPhase10ReadonlyValidationReport(partial);
  return { ...partial, reportDigest };
}

function baseFailReport(input: {
  readonly generatedAt: string;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string;
  readonly jettonMaster: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly primaryFingerprint: string;
  readonly secondaryFingerprint: string;
  readonly primaryHealth?: Phase10ReadonlyValidationHealth;
  readonly secondaryHealth?: Phase10ReadonlyValidationHealth;
  readonly primaryCoverage?: Phase10ReadonlyValidationCoverage;
  readonly secondaryCoverage?: Phase10ReadonlyValidationCoverage;
  readonly providerAgreement?: boolean;
  readonly agreedTransferCount?: number;
  readonly onlyPrimaryCount?: number;
  readonly onlySecondaryCount?: number;
  readonly agreedTransfers?: readonly Phase10ReadonlyValidationAgreedTransfer[];
  readonly verdict: Phase10ReadonlyValidationVerdict;
  readonly notes: readonly string[];
}): Phase10ReadonlyValidationReport {
  return finishReport({
    schemaVersion: PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    validationOnly: true,
    acceptanceEnabled: false,
    networkCode: 'TON_TESTNET',
    networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    hotWalletAddress: input.hotWalletAddress,
    hotWalletJettonWallet: input.hotWalletJettonWallet,
    jettonMaster: input.jettonMaster,
    observationWindow: { start: input.windowStart, end: input.windowEnd },
    primaryProviderFingerprint: input.primaryFingerprint,
    secondaryProviderFingerprint: input.secondaryFingerprint,
    primaryHealth: input.primaryHealth ?? EMPTY_HEALTH,
    secondaryHealth: input.secondaryHealth ?? EMPTY_HEALTH,
    primaryCoverage: input.primaryCoverage ?? EMPTY_COVERAGE,
    secondaryCoverage: input.secondaryCoverage ?? EMPTY_COVERAGE,
    providerAgreement: input.providerAgreement ?? false,
    agreedTransferCount: input.agreedTransferCount ?? 0,
    onlyPrimaryCount: input.onlyPrimaryCount ?? 0,
    onlySecondaryCount: input.onlySecondaryCount ?? 0,
    agreedTransfers: input.agreedTransfers ?? [],
    verdict: input.verdict,
    notes: [...input.notes],
  });
}

async function runReadonlyValidateCore(
  input: RunPhase10ChainHistoryReadonlyValidateInput,
  options: {
    readonly primaryProvider?: TonChainProvider;
    readonly secondaryProvider?: TonChainProvider;
    readonly fetchImpl?: typeof fetch;
    readonly identityOverride?: Phase10AuthoritativeHotWalletIdentity | null;
  },
): Promise<Phase10ReadonlyValidationReport> {
  if (input.realChainEnabled !== false) {
    throw new Error(
      'REFUSE: WITHDRAWAL_REAL_CHAIN_ENABLED must be false for chain-history-readonly-validate',
    );
  }
  if (input.fakeChainEnabled !== false) {
    throw new Error(
      'REFUSE: WITHDRAWAL_FAKE_CHAIN_ENABLED must be false for chain-history-readonly-validate',
    );
  }

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const jettonMaster = input.jettonMaster.trim();
  const windowStart = input.windowStart.trim();
  const windowEnd = input.windowEnd.trim();

  if (input.networkCode.trim() !== 'TON_TESTNET') {
    throw new Error(
      `REFUSE: networkCode must be TON_TESTNET (got ${input.networkCode.trim() || '<empty>'})`,
    );
  }

  const identity =
    options.identityOverride !== undefined
      ? options.identityOverride
      : await loadPhase10AuthoritativeHotWalletIdentity(input.db, {
          networkCode: 'TON_TESTNET',
        });

  const primaryKind = normalizeProviderKind(input.primary.kind);
  const secondaryKind = normalizeProviderKind(input.secondary.kind);
  const primaryFingerprint = fingerprintProviderEndpoint(input.primary.baseUrl) ?? '';
  const secondaryFingerprint = fingerprintProviderEndpoint(input.secondary.baseUrl) ?? '';

  if (identity === null) {
    return baseFailReport({
      generatedAt,
      hotWalletAddress: '',
      hotWalletJettonWallet: '',
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint,
      secondaryFingerprint,
      verdict: 'FAIL_BINDING',
      notes: ['FAIL_BINDING: authoritative Hot Wallet identity not found for TON_TESTNET'],
    });
  }

  const hotWalletAddress = identity.addressRaw.trim();
  const hotWalletJettonWallet = (identity.payoutJettonWalletAddress ?? '').trim();

  if (hotWalletJettonWallet === '') {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet: '',
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint,
      secondaryFingerprint,
      verdict: 'FAIL_BINDING',
      notes: [
        'FAIL_BINDING: hot wallet payout_jetton_wallet_address is null or empty (required for readonly validate)',
      ],
    });
  }

  if (jettonMaster === '') {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster: '',
      windowStart,
      windowEnd,
      primaryFingerprint,
      secondaryFingerprint,
      verdict: 'FAIL_BINDING',
      notes: ['FAIL_BINDING: jettonMaster is required and must be non-empty'],
    });
  }

  if (primaryKind !== 'toncenter') {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint,
      secondaryFingerprint,
      verdict: 'FAIL_BINDING',
      notes: [
        `FAIL_BINDING: primary.kind must be 'toncenter' (got ${input.primary.kind.trim() || '<empty>'})`,
      ],
    });
  }

  if (secondaryKind !== 'tonapi') {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint,
      secondaryFingerprint,
      verdict: 'FAIL_BINDING',
      notes: [
        `FAIL_BINDING: secondary.kind must be 'tonapi' (got ${input.secondary.kind.trim() || '<empty>'})`,
      ],
    });
  }

  const primaryFpRaw = fingerprintProviderEndpoint(input.primary.baseUrl);
  const secondaryFpRaw = fingerprintProviderEndpoint(input.secondary.baseUrl);
  if (primaryFpRaw === null || secondaryFpRaw === null) {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint: primaryFpRaw ?? '',
      secondaryFingerprint: secondaryFpRaw ?? '',
      verdict: 'FAIL_BINDING',
      notes: ['FAIL_BINDING: unable to derive provider endpoint fingerprints'],
    });
  }
  if (primaryFpRaw === secondaryFpRaw) {
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint: primaryFpRaw,
      secondaryFingerprint: secondaryFpRaw,
      verdict: 'FAIL_BINDING',
      notes: ['FAIL_BINDING: primary and secondary endpoint fingerprints must differ'],
    });
  }

  const fetchImpl = options.fetchImpl;
  const primary =
    options.primaryProvider ??
    createTonChainProvider({
      kind: 'toncenter',
      baseUrl: input.primary.baseUrl,
      ...(input.primary.apiKey !== undefined ? { apiKey: input.primary.apiKey } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
  const secondary =
    options.secondaryProvider ??
    createTonChainProvider({
      kind: 'tonapi',
      baseUrl: input.secondary.baseUrl,
      ...(input.secondary.apiKey !== undefined ? { apiKey: input.secondary.apiKey } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });

  const [primaryHealthRaw, secondaryHealthRaw] = await Promise.all([
    primary.health(),
    secondary.health(),
  ]);
  const primaryHealth = mapHealth(primaryHealthRaw);
  const secondaryHealth = mapHealth(secondaryHealthRaw);

  const primaryHealthOk =
    primaryHealth.ok && primaryHealth.networkGlobalId === PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID;
  const secondaryHealthOk =
    secondaryHealth.ok && secondaryHealth.networkGlobalId === PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID;

  if (!primaryHealthOk || !secondaryHealthOk) {
    const notes: string[] = [];
    if (!primaryHealthOk) {
      notes.push(
        `FAIL_PROVIDER_HEALTH: primary ok=${primaryHealth.ok} networkGlobalId=${primaryHealth.networkGlobalId}`,
      );
    }
    if (!secondaryHealthOk) {
      notes.push(
        `FAIL_PROVIDER_HEALTH: secondary ok=${secondaryHealth.ok} networkGlobalId=${secondaryHealth.networkGlobalId}`,
      );
    }
    return baseFailReport({
      generatedAt,
      hotWalletAddress,
      hotWalletJettonWallet,
      jettonMaster,
      windowStart,
      windowEnd,
      primaryFingerprint: primaryFpRaw,
      secondaryFingerprint: secondaryFpRaw,
      primaryHealth,
      secondaryHealth,
      verdict: 'FAIL_PROVIDER_HEALTH',
      notes,
    });
  }

  const enumerateInput = {
    hotWalletAddress,
    hotWalletJettonWallet,
    jettonMaster,
    windowStart,
    windowEnd,
  };

  const [primaryResult, secondaryResult] = await Promise.all([
    primary.enumerateOutgoingJettonTransfers(enumerateInput),
    secondary.enumerateOutgoingJettonTransfers(enumerateInput),
  ]);

  const primaryCoverage = coverageFromResult(primaryResult);
  const secondaryCoverage = coverageFromResult(secondaryResult);
  const incomplete =
    !primaryCoverage.windowFullyCovered ||
    !secondaryCoverage.windowFullyCovered ||
    primaryCoverage.truncated ||
    secondaryCoverage.truncated;

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

  let onlyPrimaryCount = 0;
  let onlySecondaryCount = 0;
  let multisetDisagree = false;
  const allKeys = new Set([...primaryByKey.keys(), ...secondaryByKey.keys()]);
  for (const key of allKeys) {
    const primaryCount = primaryByKey.get(key)?.length ?? 0;
    const secondaryCount = secondaryByKey.get(key)?.length ?? 0;
    if (primaryCount !== secondaryCount) {
      multisetDisagree = true;
      if (secondaryCount === 0) onlyPrimaryCount += primaryCount;
      else if (primaryCount === 0) onlySecondaryCount += secondaryCount;
      else {
        // Both present but unequal multiplicity — attribute excess to each side.
        if (primaryCount > secondaryCount) onlyPrimaryCount += primaryCount - secondaryCount;
        else onlySecondaryCount += secondaryCount - primaryCount;
      }
    }
  }

  const notes: string[] = [];
  let providerAgreement = false;
  let agreedTransfers: Phase10ReadonlyValidationAgreedTransfer[] = [];
  let verdict: Phase10ReadonlyValidationVerdict;

  if (incomplete) {
    verdict = 'FAIL_INCOMPLETE_HISTORY';
    notes.push(
      `FAIL_INCOMPLETE_HISTORY: primary windowFullyCovered=${primaryCoverage.windowFullyCovered} truncated=${primaryCoverage.truncated}; secondary windowFullyCovered=${secondaryCoverage.windowFullyCovered} truncated=${secondaryCoverage.truncated}`,
    );
  } else if (multisetDisagree) {
    verdict = 'FAIL_PROVIDER_DISAGREEMENT';
    notes.push(
      `FAIL_PROVIDER_DISAGREEMENT: onlyPrimary=${onlyPrimaryCount} onlySecondary=${onlySecondaryCount}`,
    );
  } else {
    providerAgreement = true;
    agreedTransfers = [...primaryResult.transfers]
      .sort((a, b) => a.transferIdentity.localeCompare(b.transferIdentity))
      .map(toAgreedTransfer);
    if (agreedTransfers.length >= 1) {
      verdict = 'PASS_WITH_OBSERVED_TRANSFERS';
      notes.push(`PASS_WITH_OBSERVED_TRANSFERS: agreedTransferCount=${agreedTransfers.length}`);
    } else {
      verdict = 'PASS_ZERO_OUTGOING';
      notes.push('PASS_ZERO_OUTGOING: providers agree on empty outgoing set');
    }
  }

  return finishReport({
    schemaVersion: PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
    generatedAt,
    validationOnly: true,
    acceptanceEnabled: false,
    networkCode: 'TON_TESTNET',
    networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    hotWalletAddress,
    hotWalletJettonWallet,
    jettonMaster,
    observationWindow: { start: windowStart, end: windowEnd },
    primaryProviderFingerprint: primaryFpRaw,
    secondaryProviderFingerprint: secondaryFpRaw,
    primaryHealth,
    secondaryHealth,
    primaryCoverage,
    secondaryCoverage,
    providerAgreement,
    agreedTransferCount: agreedTransfers.length,
    onlyPrimaryCount,
    onlySecondaryCount,
    agreedTransfers,
    verdict,
    notes,
  });
}

/**
 * Production readonly validation runner. Constructs TonCenter (primary) + TonAPI
 * (secondary) itself. Never accepts fetchImpl or injectable fakes.
 */
export async function runPhase10ChainHistoryReadonlyValidate(
  input: RunPhase10ChainHistoryReadonlyValidateInput,
): Promise<Phase10ReadonlyValidationReport> {
  return runReadonlyValidateCore(input, {});
}

/**
 * Test-only runner with optional provider / fetchImpl injection.
 * Not exported from package index.
 */
export async function runPhase10ChainHistoryReadonlyValidateForTests(
  input: RunPhase10ChainHistoryReadonlyValidateForTestsInput,
): Promise<Phase10ReadonlyValidationReport> {
  return runReadonlyValidateCore(input, {
    ...(input.primaryProvider !== undefined ? { primaryProvider: input.primaryProvider } : {}),
    ...(input.secondaryProvider !== undefined
      ? { secondaryProvider: input.secondaryProvider }
      : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.identityOverride !== undefined ? { identityOverride: input.identityOverride } : {}),
  });
}
