/**
 * Load / build sanitized Hot Wallet Jetton-wallet derivation proof for Phase 21 ceremony.
 * Never contains API keys, seeds, or passphrases.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import type { Phase21HotWalletDerivationProof } from './phase21-hot-wallet-registration.js';

export const PHASE21_DERIVATION_PROOF_SCHEMA = 'phase21-hot-wallet-derivation-proof.v1' as const;

export interface Phase21HotWalletDerivationProofDocument {
  readonly schemaVersion: typeof PHASE21_DERIVATION_PROOF_SCHEMA;
  readonly method: 'DUAL_PROVIDER_LIVE';
  readonly primaryJettonWalletAddress: string;
  readonly secondaryJettonWalletAddress: string;
  readonly ownerAddress: string;
  readonly jettonMaster: string;
  readonly verifiedAt: string;
  readonly primaryProviderKind: string;
  readonly secondaryProviderKind: string;
  readonly sanitized: true;
  readonly readyForLivePayout: false;
}

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function assertNonEmpty(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value.trim() === '') {
    throw new Error(`${field} required for derivation proof`);
  }
  return value.trim();
}

/**
 * Build a DUAL_PROVIDER_LIVE proof document from verified public values.
 */
export function buildPhase21HotWalletDerivationProofDocument(input: {
  readonly primaryJettonWalletAddress: string;
  readonly secondaryJettonWalletAddress: string;
  readonly ownerAddress: string;
  readonly jettonMaster: string;
  readonly verifiedAt?: string;
  readonly primaryProviderKind?: string;
  readonly secondaryProviderKind?: string;
}): Phase21HotWalletDerivationProofDocument {
  return {
    schemaVersion: PHASE21_DERIVATION_PROOF_SCHEMA,
    method: 'DUAL_PROVIDER_LIVE',
    primaryJettonWalletAddress: assertNonEmpty(
      input.primaryJettonWalletAddress,
      'primaryJettonWalletAddress',
    ),
    secondaryJettonWalletAddress: assertNonEmpty(
      input.secondaryJettonWalletAddress,
      'secondaryJettonWalletAddress',
    ),
    ownerAddress: assertNonEmpty(input.ownerAddress, 'ownerAddress'),
    jettonMaster: assertNonEmpty(input.jettonMaster, 'jettonMaster'),
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    primaryProviderKind: (input.primaryProviderKind ?? 'toncenter').trim().toLowerCase(),
    secondaryProviderKind: (input.secondaryProviderKind ?? 'tonapi').trim().toLowerCase(),
    sanitized: true,
    readyForLivePayout: false,
  };
}

export function writePhase21HotWalletDerivationProofFile(
  path: string,
  doc: Phase21HotWalletDerivationProofDocument,
): void {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readPhase21HotWalletDerivationProofFile(
  path: string,
): Phase21HotWalletDerivationProofDocument {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object') {
    throw new Error('derivation proof file must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== PHASE21_DERIVATION_PROOF_SCHEMA) {
    throw new Error(`unsupported derivation proof schemaVersion: ${String(obj.schemaVersion)}`);
  }
  if (obj.method !== 'DUAL_PROVIDER_LIVE') {
    throw new Error(
      'derivation proof method must be DUAL_PROVIDER_LIVE (OWNER_SUPPLIED_EVIDENCE refused for live ceremony CLI)',
    );
  }
  return buildPhase21HotWalletDerivationProofDocument({
    primaryJettonWalletAddress: String(obj.primaryJettonWalletAddress ?? ''),
    secondaryJettonWalletAddress: String(obj.secondaryJettonWalletAddress ?? ''),
    ownerAddress: String(obj.ownerAddress ?? ''),
    jettonMaster: String(obj.jettonMaster ?? ''),
    ...(typeof obj.verifiedAt === 'string' ? { verifiedAt: obj.verifiedAt } : {}),
    ...(typeof obj.primaryProviderKind === 'string'
      ? { primaryProviderKind: obj.primaryProviderKind }
      : {}),
    ...(typeof obj.secondaryProviderKind === 'string'
      ? { secondaryProviderKind: obj.secondaryProviderKind }
      : {}),
  });
}

/**
 * Resolve derivation proof for hot-wallet:plan / hot-wallet:register.
 *
 * Preference order:
 * 1. PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE (sanitized evidence JSON)
 * 2. Explicit env fields PHASE21_HOT_WALLET_DERIVATION_*
 *
 * Live ceremony CLI requires method=DUAL_PROVIDER_LIVE.
 * Returns null when no proof source is configured (planner will BLOCK).
 */
export function resolvePhase21HotWalletDerivationProofFromEnv(): {
  readonly proof: Phase21HotWalletDerivationProof | null;
  readonly source: 'FILE' | 'ENV' | 'MISSING';
  readonly refuseCode?: string;
  readonly message?: string;
} {
  const filePath = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE');
  if (filePath !== null) {
    try {
      const doc = readPhase21HotWalletDerivationProofFile(filePath);
      return {
        proof: {
          primaryJettonWalletAddress: doc.primaryJettonWalletAddress,
          secondaryJettonWalletAddress: doc.secondaryJettonWalletAddress,
          method: 'DUAL_PROVIDER_LIVE',
          verifiedAt: doc.verifiedAt,
          ownerAddress: doc.ownerAddress,
          jettonMaster: doc.jettonMaster,
          primaryProviderKind: doc.primaryProviderKind,
          secondaryProviderKind: doc.secondaryProviderKind,
        },
        source: 'FILE',
      };
    } catch (error: unknown) {
      return {
        proof: null,
        source: 'FILE',
        refuseCode: 'DERIVATION_PROOF_FILE_INVALID',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const primary = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_PRIMARY');
  const secondary = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_SECONDARY');
  const method = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_METHOD');
  const ownerAddress = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_OWNER');
  const jettonMaster = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_JETTON_MASTER');
  const verifiedAt = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_VERIFIED_AT') ?? undefined;
  const primaryProviderKind = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_PRIMARY_PROVIDER');
  const secondaryProviderKind = envNonEmpty('PHASE21_HOT_WALLET_DERIVATION_SECONDARY_PROVIDER');

  if (
    primary === null &&
    secondary === null &&
    method === null &&
    ownerAddress === null &&
    jettonMaster === null
  ) {
    return { proof: null, source: 'MISSING' };
  }

  if (
    primary === null ||
    secondary === null ||
    method === null ||
    ownerAddress === null ||
    jettonMaster === null
  ) {
    return {
      proof: null,
      source: 'ENV',
      refuseCode: 'DERIVATION_PROOF_ENV_INCOMPLETE',
      message:
        'PHASE21_HOT_WALLET_DERIVATION_PRIMARY, _SECONDARY, _METHOD, _OWNER, and _JETTON_MASTER are all required together',
    };
  }

  if (method !== 'DUAL_PROVIDER_LIVE') {
    return {
      proof: null,
      source: 'ENV',
      refuseCode: 'DERIVATION_PROOF_METHOD_REFUSED',
      message:
        'Live ceremony CLI requires PHASE21_HOT_WALLET_DERIVATION_METHOD=DUAL_PROVIDER_LIVE (OWNER_SUPPLIED_EVIDENCE refused)',
    };
  }

  // ENV without complete provider provenance is not APPLY-ready (PLAN may still surface blockers).
  if (
    primaryProviderKind === null ||
    secondaryProviderKind === null ||
    verifiedAt === undefined ||
    verifiedAt.trim() === ''
  ) {
    return {
      proof: {
        primaryJettonWalletAddress: primary,
        secondaryJettonWalletAddress: secondary,
        method: 'DUAL_PROVIDER_LIVE',
        ownerAddress,
        jettonMaster,
        ...(verifiedAt !== undefined ? { verifiedAt } : {}),
        ...(primaryProviderKind !== null ? { primaryProviderKind } : {}),
        ...(secondaryProviderKind !== null ? { secondaryProviderKind } : {}),
      },
      source: 'ENV',
      refuseCode: 'DERIVATION_PROOF_ENV_PROVENANCE_INCOMPLETE',
      message:
        'ENV derivation proof lacks provider kinds / verifiedAt — not APPLY-ready; prefer PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE',
    };
  }

  return {
    proof: {
      primaryJettonWalletAddress: primary,
      secondaryJettonWalletAddress: secondary,
      method: 'DUAL_PROVIDER_LIVE',
      ownerAddress,
      jettonMaster,
      verifiedAt,
      primaryProviderKind,
      secondaryProviderKind,
    },
    source: 'ENV',
  };
}
