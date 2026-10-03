/**
 * Sanitized Hot Wallet identity-proof document (schema + registration binding).
 * Cryptographic offline verify-from-encrypted-bundle lives in apps/signer
 * (avoids withdrawals↔signing package cycle). readyForLivePayout always false.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { tonAddressesEqual } from '@alex-rewards/ton';

export const PHASE21_HOT_WALLET_IDENTITY_PROOF_SCHEMA =
  'phase21-hot-wallet-identity-proof.v1' as const;

export type Phase21HotWalletIdentityProof = {
  readonly schemaVersion: typeof PHASE21_HOT_WALLET_IDENTITY_PROOF_SCHEMA;
  readonly networkCode: 'TON_MAINNET';
  readonly networkGlobalId: -239;
  readonly walletVersion: 'v5R1';
  readonly workchain: 0;
  readonly addressRaw: string;
  readonly addressFriendly: string;
  readonly publicKeyFingerprintSha256: string;
  readonly encryptedBundleSha256: string;
  readonly verifiedAt: string;
  readonly sanitized: true;
  readonly readyForLivePayout: false;
};

export class Phase21HotWalletIdentityProofError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21HotWalletIdentityProofError';
    this.code = code;
    this.details = details;
  }
}

export function buildPhase21HotWalletIdentityProofDocument(input: {
  readonly addressRaw: string;
  readonly addressFriendly: string;
  readonly publicKeyFingerprintSha256: string;
  readonly encryptedBundleSha256: string;
  readonly networkGlobalId?: number;
  readonly walletVersion?: string;
  readonly workchain?: number;
  readonly verifiedAt?: string;
}): Phase21HotWalletIdentityProof {
  if (input.networkGlobalId !== undefined && input.networkGlobalId !== -239) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_NETWORK_REJECTED',
      'identity proof requires networkGlobalId=-239',
      { networkGlobalId: input.networkGlobalId },
    );
  }
  if (input.walletVersion !== undefined && input.walletVersion !== 'v5R1') {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_WALLET_VERSION_REJECTED',
      'identity proof requires walletVersion=v5R1',
      { walletVersion: input.walletVersion },
    );
  }
  if (input.workchain !== undefined && input.workchain !== 0) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_WORKCHAIN_REJECTED',
      'identity proof requires workchain=0',
      { workchain: input.workchain },
    );
  }
  return {
    schemaVersion: PHASE21_HOT_WALLET_IDENTITY_PROOF_SCHEMA,
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    walletVersion: 'v5R1',
    workchain: 0,
    addressRaw: input.addressRaw.trim(),
    addressFriendly: input.addressFriendly.trim(),
    publicKeyFingerprintSha256: input.publicKeyFingerprintSha256.trim().toLowerCase(),
    encryptedBundleSha256: input.encryptedBundleSha256.trim().toLowerCase(),
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    sanitized: true,
    readyForLivePayout: false,
  };
}

export function writePhase21HotWalletIdentityProofFile(
  path: string,
  proof: Phase21HotWalletIdentityProof,
): void {
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function readPhase21HotWalletIdentityProofFile(path: string): Phase21HotWalletIdentityProof {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object') {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_INVALID',
      'identity proof file must be a JSON object',
      {},
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== PHASE21_HOT_WALLET_IDENTITY_PROOF_SCHEMA) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_SCHEMA_UNSUPPORTED',
      `unsupported identity proof schemaVersion: ${String(obj.schemaVersion)}`,
      {},
    );
  }
  if (obj.sanitized !== true || obj.readyForLivePayout !== false) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_NOT_SANITIZED',
      'identity proof must be sanitized:true and readyForLivePayout:false',
      {},
    );
  }
  for (const forbidden of ['seed', 'secretKey', 'privateKey', 'passphrase', 'mnemonic']) {
    if (forbidden in obj) {
      throw new Phase21HotWalletIdentityProofError(
        'IDENTITY_PROOF_CONTAINS_SECRETS',
        `identity proof must not contain ${forbidden}`,
        {},
      );
    }
  }
  return buildPhase21HotWalletIdentityProofDocument({
    addressRaw: String(obj.addressRaw ?? ''),
    addressFriendly: String(obj.addressFriendly ?? ''),
    publicKeyFingerprintSha256: String(obj.publicKeyFingerprintSha256 ?? ''),
    encryptedBundleSha256: String(obj.encryptedBundleSha256 ?? ''),
    networkGlobalId: Number(obj.networkGlobalId),
    walletVersion: String(obj.walletVersion ?? ''),
    workchain: Number(obj.workchain),
    ...(typeof obj.verifiedAt === 'string' ? { verifiedAt: obj.verifiedAt } : {}),
  });
}

export function assertIdentityProofMatchesRegistrationInput(
  proof: Phase21HotWalletIdentityProof,
  expected: {
    readonly address: string;
    readonly signerReference: string;
    readonly friendlyAddress?: string | null;
  },
): void {
  if (proof.networkGlobalId !== -239 || proof.walletVersion !== 'v5R1' || proof.workchain !== 0) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_NETWORK_MISMATCH',
      'identity proof network/version/workchain mismatch',
      {},
    );
  }
  const addressOk =
    tonAddressesEqual(proof.addressRaw, expected.address) ||
    tonAddressesEqual(proof.addressFriendly, expected.address);
  if (!addressOk) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_ADDRESS_MISMATCH',
      'identity proof address does not match registration address',
      {},
    );
  }
  if (
    proof.publicKeyFingerprintSha256.toLowerCase() !==
    expected.signerReference.trim().toLowerCase()
  ) {
    throw new Phase21HotWalletIdentityProofError(
      'IDENTITY_PROOF_FINGERPRINT_MISMATCH',
      'identity proof fingerprint does not match signerReference',
      {},
    );
  }
  if (
    expected.friendlyAddress !== undefined &&
    expected.friendlyAddress !== null &&
    expected.friendlyAddress.trim() !== ''
  ) {
    if (!tonAddressesEqual(proof.addressFriendly, expected.friendlyAddress)) {
      throw new Phase21HotWalletIdentityProofError(
        'IDENTITY_PROOF_FRIENDLY_MISMATCH',
        'identity proof friendly address does not match registration friendlyAddress',
        {},
      );
    }
  }
}
