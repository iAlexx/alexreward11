/**
 * Authoritative Hot Wallet outgoing Jetton history evidence for Phase 10 acceptance.
 * Caller booleans alone are never sufficient. No secrets.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PHASE10_CHAIN_HISTORY_PROOF_REQUIRED = 'CHAIN_HISTORY_PROOF_REQUIRED' as const;

export type Phase10ChainHistoryReconciliationResult =
  | 'ZERO_UNEXPECTED'
  | 'UNEXPECTED_OUTGOING'
  | typeof PHASE10_CHAIN_HISTORY_PROOF_REQUIRED
  | 'MALFORMED';

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
   * Authoritative enumerated outgoing transfers from provider observation.
   * When null/undefined, evidence is CHAIN_HISTORY_PROOF_REQUIRED (enumeration unavailable).
   */
  readonly enumeratedOutgoingTransfers?: readonly Phase10ChainHistoryOutgoingTransfer[] | null;
  readonly expectedCampaignPayoutIdentities: readonly string[];
  readonly notes?: readonly string[];
  readonly generatedAt?: string;
}

function digestTransfers(transfers: readonly Phase10ChainHistoryOutgoingTransfer[]): string {
  const payload = transfers
    .map((t) => `${t.transferIdentity}|${t.transactionHash ?? ''}|${t.queryId ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Build chain-history evidence from authoritative enumeration (or mark PROOF_REQUIRED).
 * Never accepts a bare caller boolean as proof.
 */
export function buildPhase10ChainHistoryEvidence(
  input: BuildPhase10ChainHistoryEvidenceInput,
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

  if (
    input.enumeratedOutgoingTransfers === null ||
    input.enumeratedOutgoingTransfers === undefined
  ) {
    notes.push(
      'CHAIN_HISTORY_PROOF_REQUIRED: arbitrary outgoing history enumeration unavailable; acceptance remains blocked',
    );
    return {
      schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
      generatedAt,
      hotWalletAddress: input.hotWalletAddress.trim(),
      hotWalletJettonWallet: input.hotWalletJettonWallet?.trim() || null,
      networkCode: 'TON_TESTNET',
      networkGlobalId: input.networkGlobalId ?? -3,
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
      notes,
      evidenceDigest: digestTransfers([]),
    };
  }

  const outgoing = [...input.enumeratedOutgoingTransfers];
  const expectedSet = new Set(expected);
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
    notes.push('authoritative zero-unexpected outgoing Jetton transfers in observation window');
  }

  return {
    schemaVersion: PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    hotWalletAddress: input.hotWalletAddress.trim(),
    hotWalletJettonWallet: input.hotWalletJettonWallet?.trim() || null,
    networkCode: 'TON_TESTNET',
    networkGlobalId: input.networkGlobalId ?? -3,
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
    notes,
    evidenceDigest: digestTransfers(outgoing),
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

  if (errors.length > 0) {
    return { errors, parsed: null };
  }

  return { errors: [], parsed: root as unknown as Phase10ChainHistoryEvidenceArtifact };
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

/**
 * Acceptance evaluation of chain-history evidence.
 * ZERO_UNEXPECTED → eligible to continue; all other results refuse.
 */
export function evaluateChainHistoryForAcceptance(raw: unknown): {
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
  if (parsed.reconciliationResult === PHASE10_CHAIN_HISTORY_PROOF_REQUIRED) {
    return {
      ok: false,
      reasons: ['CHAIN_HISTORY_PROOF_REQUIRED: authoritative outgoing history proof absent'],
      unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
    };
  }
  if (parsed.reconciliationResult === 'UNEXPECTED_OUTGOING' || parsed.unexpectedOutgoingCount > 0) {
    return {
      ok: false,
      reasons: [
        `external hot-wallet history has ${parsed.unexpectedOutgoingCount} unexpected outgoing transfer(s)`,
      ],
      unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
    };
  }
  if (parsed.reconciliationResult !== 'ZERO_UNEXPECTED') {
    return {
      ok: false,
      reasons: [`chain-history reconciliationResult=${parsed.reconciliationResult}`],
      unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
    };
  }
  if (parsed.providerIdentity.independenceProven !== true) {
    return {
      ok: false,
      reasons: ['chain-history evidence provider independence not proven'],
      unexpectedOutgoingCount: parsed.unexpectedOutgoingCount,
    };
  }
  return { ok: true, reasons: [], unexpectedOutgoingCount: 0 };
}
