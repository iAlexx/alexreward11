/**
 * Authoritative Hot Wallet outgoing Jetton history evidence for Phase 10 acceptance.
 * Caller booleans / caller arrays / empty arrays alone are never sufficient.
 * Until a provider-backed enumeration port exists, evidence remains
 * CHAIN_HISTORY_PROOF_REQUIRED (fail closed). No secrets.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PHASE10_CHAIN_HISTORY_PROOF_REQUIRED = 'CHAIN_HISTORY_PROOF_REQUIRED' as const;
export const PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID = -3 as const;
/**
 * Flip only when a real read-only provider-backed full outgoing Jetton history
 * collector exists and is wired into evidence generation. Until then, any claimed
 * PROVIDER_BACKED authority is refused by acceptance.
 */
export const PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE = false as const;

export type Phase10ChainHistoryReconciliationResult =
  | 'ZERO_UNEXPECTED'
  | 'UNEXPECTED_OUTGOING'
  | typeof PHASE10_CHAIN_HISTORY_PROOF_REQUIRED
  | 'MALFORMED';

export type Phase10ChainHistoryEnumerationAuthority =
  'PROVIDER_BACKED' | 'UNAVAILABLE' | 'CALLER_SUPPLIED_UNTRUSTED';

export interface Phase10ChainHistoryOutgoingTransfer {
  readonly transferIdentity: string;
  readonly transactionHash: string | null;
  readonly queryId: string | null;
  readonly amountAtomic: string | null;
  readonly recipient: string | null;
  readonly observedAt: string | null;
  readonly providerKind: string | null;
}

export interface Phase10ChainHistoryEvidenceArtifact {
  readonly schemaVersion: typeof PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet: string | null;
  readonly networkCode: 'TON_TESTNET';
  readonly networkGlobalId: number;
  readonly jettonMaster: string;
  readonly observationWindow: {
    readonly start: string;
    readonly end: string;
  };
  readonly providerIdentity: {
    readonly primaryKind: string | null;
    readonly primaryEndpointFingerprint: string | null;
    readonly secondaryKind: string | null;
    readonly secondaryEndpointFingerprint: string | null;
    readonly independenceProven: boolean;
  };
  readonly outgoingTransfers: readonly Phase10ChainHistoryOutgoingTransfer[];
  readonly expectedCampaignPayoutIdentities: readonly string[];
  readonly unexpectedOutgoingCount: number;
  readonly reconciliationResult: Phase10ChainHistoryReconciliationResult;
  /**
   * Enumeration authority. Only PROVIDER_BACKED may ever yield ZERO_UNEXPECTED
   * for acceptance. Caller-supplied arrays are CALLER_SUPPLIED_UNTRUSTED.
   */
  readonly enumerationAuthority: Phase10ChainHistoryEnumerationAuthority;
  readonly notes: readonly string[];
  /** Integrity fingerprint of enumerated transfer identities (no secrets). */
  readonly evidenceDigest: string;
}

export interface BuildPhase10ChainHistoryEvidenceInput {
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet?: string | null;
  readonly jettonMaster: string;
  readonly networkGlobalId?: number;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly providerIdentity: Phase10ChainHistoryEvidenceArtifact['providerIdentity'];
  /**
   * Caller-supplied enumerated transfers are NEVER authoritative.
   * Presence of any caller list (including []) yields CHAIN_HISTORY_PROOF_REQUIRED
   * until a provider-backed enumerator exists.
   */
  readonly enumeratedOutgoingTransfers?: readonly Phase10ChainHistoryOutgoingTransfer[] | null;
  readonly expectedCampaignPayoutIdentities: readonly string[];
  readonly notes?: readonly string[];
  readonly generatedAt?: string;
}

/**
 * Internal builder for future provider-backed enumeration only.
 * Not exported via public caller-array path — keeps fail-closed default.
 */
export interface BuildPhase10ProviderBackedChainHistoryInput {
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet?: string | null;
  readonly jettonMaster: string;
  readonly networkGlobalId: number;
  readonly observationWindow: { readonly start: string; readonly end: string };
  readonly providerIdentity: Phase10ChainHistoryEvidenceArtifact['providerIdentity'];
  readonly providerEnumeratedOutgoingTransfers: readonly Phase10ChainHistoryOutgoingTransfer[];
  readonly expectedCampaignPayoutIdentities: readonly string[];
  readonly notes?: readonly string[];
  readonly generatedAt?: string;
}

export function digestChainHistoryTransfers(
  transfers: readonly Phase10ChainHistoryOutgoingTransfer[],
): string {
  const payload = transfers
    .map((t) => `${t.transferIdentity}|${t.transactionHash ?? ''}|${t.queryId ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function proofRequiredArtifact(
  input: BuildPhase10ChainHistoryEvidenceInput,
  notes: string[],
  authority: Phase10ChainHistoryEnumerationAuthority,
): Phase10ChainHistoryEvidenceArtifact {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const expected = [
    ...new Set(
      input.expectedCampaignPayoutIdentities.filter(
        (id) => typeof id === 'string' && id.trim() !== '',
      ),
    ),
  ];
  return {
    schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet?.trim() || null,
    networkCode: 'TON_TESTNET',
    networkGlobalId: input.networkGlobalId ?? PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    jettonMaster: input.jettonMaster.trim(),
    observationWindow: {
      start: input.observationWindow.start,
      end: input.observationWindow.end,
    },
    providerIdentity: input.providerIdentity,
    outgoingTransfers: [],
    expectedCampaignPayoutIdentities: expected,
    unexpectedOutgoingCount: 0,
    reconciliationResult: PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
    enumerationAuthority: authority,
    notes,
    evidenceDigest: digestChainHistoryTransfers([]),
  };
}

/**
 * Build chain-history evidence. Caller-supplied enumeration (including []) is
 * never treated as ZERO_UNEXPECTED — fail closed with CHAIN_HISTORY_PROOF_REQUIRED.
 */
export function buildPhase10ChainHistoryEvidence(
  input: BuildPhase10ChainHistoryEvidenceInput,
): Phase10ChainHistoryEvidenceArtifact {
  const notes = [...(input.notes ?? [])];

  if (
    input.enumeratedOutgoingTransfers === null ||
    input.enumeratedOutgoingTransfers === undefined
  ) {
    notes.push(
      'CHAIN_HISTORY_PROOF_REQUIRED: provider-backed outgoing history enumeration unavailable; acceptance remains blocked',
    );
    return proofRequiredArtifact(input, notes, 'UNAVAILABLE');
  }

  notes.push(
    'CHAIN_HISTORY_PROOF_REQUIRED: caller-supplied enumeratedOutgoingTransfers (including empty arrays) are not authoritative; provider-backed enumeration required',
  );
  return proofRequiredArtifact(input, notes, 'CALLER_SUPPLIED_UNTRUSTED');
}

/**
 * Internal-only builder for forged/provider-shaped artifacts in package tests.
 * NOT part of the public package API — do not re-export from index.ts.
 * Acceptance refuses PROVIDER_BACKED until PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE.
 */
export function buildPhase10ProviderBackedChainHistoryEvidenceForTests(
  input: BuildPhase10ProviderBackedChainHistoryInput,
): Phase10ChainHistoryEvidenceArtifact {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const expected = [
    ...new Set(
      input.expectedCampaignPayoutIdentities.filter(
        (id) => typeof id === 'string' && id.trim() !== '',
      ),
    ),
  ];
  const notes = [...(input.notes ?? [])];
  const outgoing = [...input.providerEnumeratedOutgoingTransfers];
  const expectedSet = new Set(expected);

  // Every expected campaign payout identity must appear in enumerated history.
  const missingExpected: string[] = [];
  for (const id of expected) {
    const found = outgoing.some((t) => {
      const ids = [t.transferIdentity, t.transactionHash, t.queryId].filter(
        (x): x is string => typeof x === 'string' && x.trim() !== '',
      );
      return ids.includes(id);
    });
    if (!found) missingExpected.push(id);
  }
  if (missingExpected.length > 0) {
    notes.push(
      `CHAIN_HISTORY_PROOF_REQUIRED: ${missingExpected.length} expected campaign payout identity(ies) missing from provider history`,
    );
    return {
      schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
      generatedAt,
      hotWalletAddress: input.hotWalletAddress.trim(),
      hotWalletJettonWallet: input.hotWalletJettonWallet?.trim() || null,
      networkCode: 'TON_TESTNET',
      networkGlobalId: input.networkGlobalId,
      jettonMaster: input.jettonMaster.trim(),
      observationWindow: {
        start: input.observationWindow.start,
        end: input.observationWindow.end,
      },
      providerIdentity: input.providerIdentity,
      outgoingTransfers: outgoing,
      expectedCampaignPayoutIdentities: expected,
      unexpectedOutgoingCount: 0,
      reconciliationResult: PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
      enumerationAuthority: 'PROVIDER_BACKED',
      notes,
      evidenceDigest: digestChainHistoryTransfers(outgoing),
    };
  }

  let unexpected = 0;
  for (const t of outgoing) {
    const ids = [t.transferIdentity, t.transactionHash, t.queryId].filter(
      (x): x is string => typeof x === 'string' && x.trim() !== '',
    );
    if (!ids.some((id) => expectedSet.has(id))) {
      unexpected += 1;
    }
  }

  const reconciliationResult: Phase10ChainHistoryReconciliationResult =
    unexpected > 0 ? 'UNEXPECTED_OUTGOING' : 'ZERO_UNEXPECTED';
  if (unexpected > 0) {
    notes.push(`unexpected outgoing Jetton transfers: ${unexpected}`);
  } else {
    notes.push('provider-backed zero-unexpected outgoing Jetton transfers in observation window');
  }

  return {
    schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet?.trim() || null,
    networkCode: 'TON_TESTNET',
    networkGlobalId: input.networkGlobalId,
    jettonMaster: input.jettonMaster.trim(),
    observationWindow: {
      start: input.observationWindow.start,
      end: input.observationWindow.end,
    },
    providerIdentity: input.providerIdentity,
    outgoingTransfers: outgoing,
    expectedCampaignPayoutIdentities: expected,
    unexpectedOutgoingCount: unexpected,
    reconciliationResult,
    enumerationAuthority: 'PROVIDER_BACKED',
    notes,
    evidenceDigest: digestChainHistoryTransfers(outgoing),
  };
}

export async function writePhase10ChainHistoryEvidence(
  path: string,
  input: BuildPhase10ChainHistoryEvidenceInput,
): Promise<Phase10ChainHistoryEvidenceArtifact> {
  const artifact = buildPhase10ChainHistoryEvidence(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

export function parsePhase10ChainHistoryEvidence(raw: unknown): {
  readonly errors: readonly string[];
  readonly parsed: Phase10ChainHistoryEvidenceArtifact | null;
} {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['chain-history evidence is not a JSON object'], parsed: null };
  }
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    errors.push('chain-history evidence schemaVersion must be 1');
  }
  if (typeof root.hotWalletAddress !== 'string' || root.hotWalletAddress.trim() === '') {
    errors.push('chain-history evidence missing hotWalletAddress');
  }
  if (typeof root.jettonMaster !== 'string' || root.jettonMaster.trim() === '') {
    errors.push('chain-history evidence missing jettonMaster');
  }
  if (root.networkCode !== 'TON_TESTNET') {
    errors.push('chain-history evidence networkCode must be TON_TESTNET');
  }
  if (typeof root.generatedAt !== 'string' || root.generatedAt.trim() === '') {
    errors.push('chain-history evidence missing generatedAt');
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
    errors.push('chain-history evidence missing observationWindow.start/end');
  }
  const provider =
    root.providerIdentity !== null && typeof root.providerIdentity === 'object'
      ? (root.providerIdentity as Record<string, unknown>)
      : null;
  if (provider === null) {
    errors.push('chain-history evidence missing providerIdentity');
  }
  if (!Array.isArray(root.outgoingTransfers)) {
    errors.push('chain-history evidence missing outgoingTransfers array');
  }
  if (!Array.isArray(root.expectedCampaignPayoutIdentities)) {
    errors.push('chain-history evidence missing expectedCampaignPayoutIdentities array');
  }
  if (
    typeof root.unexpectedOutgoingCount !== 'number' ||
    !Number.isFinite(root.unexpectedOutgoingCount)
  ) {
    errors.push('chain-history evidence missing numeric unexpectedOutgoingCount');
  }
  const result = root.reconciliationResult;
  if (
    result !== 'ZERO_UNEXPECTED' &&
    result !== 'UNEXPECTED_OUTGOING' &&
    result !== PHASE10_CHAIN_HISTORY_PROOF_REQUIRED &&
    result !== 'MALFORMED'
  ) {
    errors.push('chain-history evidence reconciliationResult invalid');
  }
  if (typeof root.evidenceDigest !== 'string' || root.evidenceDigest.trim() === '') {
    errors.push('chain-history evidence missing evidenceDigest');
  }
  // Reject operator-boolean masquerades.
  if (root.unexpectedOutgoingHistoryProven === true || root.provenByOperator === true) {
    errors.push(
      'caller boolean unexpectedOutgoingHistoryProven/provenByOperator is not authoritative',
    );
  }
  // Reject validation-only readonly reports (distinct schema; never acceptance evidence).
  if (root.validationOnly === true) {
    errors.push(
      'readonly validation report (validationOnly) is not chain-history acceptance evidence',
    );
  }

  if (errors.length > 0) {
    return { errors, parsed: null };
  }

  const authority =
    root.enumerationAuthority === 'PROVIDER_BACKED' ||
    root.enumerationAuthority === 'UNAVAILABLE' ||
    root.enumerationAuthority === 'CALLER_SUPPLIED_UNTRUSTED'
      ? root.enumerationAuthority
      : // Legacy artifacts without authority are treated as untrusted.
        'CALLER_SUPPLIED_UNTRUSTED';

  return {
    errors: [],
    parsed: {
      ...(root as unknown as Phase10ChainHistoryEvidenceArtifact),
      enumerationAuthority: authority,
    },
  };
}

export async function readPhase10ChainHistoryEvidence(path: string): Promise<{
  readonly errors: readonly string[];
  readonly parsed: Phase10ChainHistoryEvidenceArtifact | null;
}> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsePhase10ChainHistoryEvidence(raw);
  } catch (error) {
    return {
      errors: [
        `chain-history evidence missing or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      parsed: null,
    };
  }
}

export interface Phase10ChainHistoryAcceptanceBinding {
  readonly hotWalletAddress: string;
  readonly hotWalletJettonWallet?: string | null;
  readonly jettonMaster: string;
  readonly networkGlobalId?: number;
  readonly campaignWindowStart?: string | null;
  readonly campaignWindowEnd?: string | null;
  readonly primaryEndpointFingerprint?: string | null;
  readonly secondaryEndpointFingerprint?: string | null;
  readonly expectedCampaignPayoutIdentities?: readonly string[];
}

/**
 * Acceptance evaluation of chain-history evidence.
 * Until a real provider-backed collector exists, claimed PROVIDER_BACKED never PASSes.
 * Binding checks still run against authoritative (caller-supplied binding) values.
 */
export function evaluateChainHistoryForAcceptance(
  raw: unknown,
  binding?: Phase10ChainHistoryAcceptanceBinding | null,
): {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly unexpectedOutgoingCount: number;
} {
  const { errors, parsed } = parsePhase10ChainHistoryEvidence(raw);
  if (parsed === null) {
    return {
      ok: false,
      reasons: errors.length > 0 ? errors : ['chain-history evidence malformed'],
      unexpectedOutgoingCount: 0,
    };
  }

  const reasons: string[] = [];

  // Always recompute digest — never trust stored digest alone.
  const recomputed = digestChainHistoryTransfers(parsed.outgoingTransfers);
  if (recomputed !== parsed.evidenceDigest) {
    reasons.push('chain-history evidenceDigest mismatch (recomputed from transfer records)');
  }

  if (parsed.networkCode !== 'TON_TESTNET') {
    reasons.push('chain-history networkCode must be TON_TESTNET');
  }
  if (parsed.networkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
    reasons.push(
      `chain-history networkGlobalId must be ${PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID} (got ${parsed.networkGlobalId})`,
    );
  }

  // Fail closed: no real collector → claimed PROVIDER_BACKED is never acceptance-grade.
  // Boolean read so flipping the const later does not trip exact `false !== true` exhaustiveness.
  const collectorAvailable = PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE as boolean;
  if (!collectorAvailable) {
    reasons.push(
      'CHAIN_HISTORY_PROOF_REQUIRED: provider-backed outgoing Jetton history collector is not available; claimed PROVIDER_BACKED authority is refused',
    );
  } else if (parsed.enumerationAuthority !== 'PROVIDER_BACKED') {
    reasons.push(
      'CHAIN_HISTORY_PROOF_REQUIRED: enumerationAuthority must be PROVIDER_BACKED (caller arrays / empty lists / hand-built ZERO_UNEXPECTED are refused)',
    );
  }

  if (parsed.reconciliationResult === PHASE10_CHAIN_HISTORY_PROOF_REQUIRED) {
    reasons.push('CHAIN_HISTORY_PROOF_REQUIRED: authoritative outgoing history proof absent');
  }
  if (parsed.reconciliationResult === 'UNEXPECTED_OUTGOING' || parsed.unexpectedOutgoingCount > 0) {
    reasons.push(
      `external hot-wallet history has ${parsed.unexpectedOutgoingCount} unexpected outgoing transfer(s)`,
    );
  }
  if (parsed.providerIdentity.independenceProven !== true) {
    reasons.push('chain-history evidence provider independence not proven');
  }

  if (binding !== null && binding !== undefined) {
    if (normalizeLoose(parsed.hotWalletAddress) !== normalizeLoose(binding.hotWalletAddress)) {
      reasons.push('chain-history hotWalletAddress does not match authoritative Hot Wallet');
    }
    if (
      binding.hotWalletJettonWallet !== undefined &&
      binding.hotWalletJettonWallet !== null &&
      normalizeLoose(parsed.hotWalletJettonWallet ?? '') !==
        normalizeLoose(binding.hotWalletJettonWallet)
    ) {
      reasons.push(
        'chain-history hotWalletJettonWallet does not match authoritative Jetton wallet',
      );
    }
    if (normalizeLoose(parsed.jettonMaster) !== normalizeLoose(binding.jettonMaster)) {
      reasons.push('chain-history jettonMaster does not match authoritative Jetton master');
    }
    if (
      binding.networkGlobalId !== undefined &&
      parsed.networkGlobalId !== binding.networkGlobalId
    ) {
      reasons.push('chain-history networkGlobalId does not match binding');
    }
    if (
      binding.campaignWindowStart !== undefined &&
      binding.campaignWindowStart !== null &&
      Date.parse(parsed.observationWindow.start) > Date.parse(binding.campaignWindowStart)
    ) {
      reasons.push('chain-history observationWindow does not cover campaign start');
    }
    if (
      binding.campaignWindowEnd !== undefined &&
      binding.campaignWindowEnd !== null &&
      Date.parse(parsed.observationWindow.end) < Date.parse(binding.campaignWindowEnd)
    ) {
      reasons.push('chain-history observationWindow does not cover campaign end');
    }
    if (
      binding.primaryEndpointFingerprint !== undefined &&
      binding.primaryEndpointFingerprint !== null &&
      parsed.providerIdentity.primaryEndpointFingerprint !== binding.primaryEndpointFingerprint
    ) {
      reasons.push('chain-history primary provider fingerprint mismatches readiness evidence');
    }
    if (
      binding.secondaryEndpointFingerprint !== undefined &&
      binding.secondaryEndpointFingerprint !== null &&
      parsed.providerIdentity.secondaryEndpointFingerprint !== binding.secondaryEndpointFingerprint
    ) {
      reasons.push('chain-history secondary provider fingerprint mismatches readiness evidence');
    }
    if (binding.expectedCampaignPayoutIdentities !== undefined) {
      const expected = new Set(binding.expectedCampaignPayoutIdentities);
      const artifactExpected = new Set(parsed.expectedCampaignPayoutIdentities);
      for (const id of expected) {
        if (!artifactExpected.has(id)) {
          reasons.push('chain-history expectedCampaignPayoutIdentities missing DB-derived payout');
          break;
        }
      }
    }
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
    };
  }

  if (
    collectorAvailable &&
    parsed.enumerationAuthority === 'PROVIDER_BACKED' &&
    parsed.reconciliationResult === 'ZERO_UNEXPECTED'
  ) {
    return { ok: true, reasons: [], unexpectedOutgoingCount: 0 };
  }

  return {
    ok: false,
    reasons: ['CHAIN_HISTORY_PROOF_REQUIRED: authoritative outgoing history proof absent'],
    unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
  };
}

function normalizeLoose(value: string): string {
  return value.trim().toLowerCase();
}
