import { signVerify } from '@ton/crypto';

import { parseTonConnectAccountAddress, type CanonicalTonAddress } from './address.js';
import { TonDomainError } from './errors.js';
import { buildTonProofSigningDigest } from './proof-message.js';
import {
  assertStateInitMatchesAddress,
  extractPublicKeyFromStateInit,
  parseStateInitFromBase64,
} from './state-init.js';

/** TON Connect network ids: mainnet `-239`, testnet `-3`. */
export type TonConnectNetworkId = '-239' | '-3';

export interface TonConnectAccount {
  readonly address: string;
  readonly network: string;
  readonly publicKey?: string;
  readonly walletStateInit?: string;
}

export interface TonProofDomain {
  readonly lengthBytes: number;
  readonly value: string;
}

export interface TonProofObject {
  readonly timestamp: number;
  readonly domain: TonProofDomain;
  readonly payload: string;
  readonly signature: string;
  readonly stateInit?: string;
  readonly state_init?: string;
}

export interface VerifyTonProofInput {
  readonly account: TonConnectAccount;
  readonly proof: TonProofObject;
  readonly expectedDomain: string;
  readonly expectedPayload: string;
  /** Server-selected accepted network id for this deployment. */
  readonly expectedNetwork: TonConnectNetworkId;
  readonly nowUnixSeconds?: number;
  readonly maxAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
}

export interface VerifiedTonProof {
  readonly canonical: CanonicalTonAddress;
  readonly publicKeyHex: string;
  readonly network: TonConnectNetworkId;
  readonly proofTimestamp: number;
}

function resolveStateInitBase64(proof: TonProofObject, account: TonConnectAccount): string {
  const fromProof = proof.stateInit ?? proof.state_init;
  if (typeof fromProof === 'string' && fromProof.trim() !== '') return fromProof.trim();
  if (typeof account.walletStateInit === 'string' && account.walletStateInit.trim() !== '') {
    return account.walletStateInit.trim();
  }
  throw new TonDomainError('INVALID_WALLET', 'Wallet state cannot be verified');
}

function decodeSignature(signatureBase64: string): Buffer {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
  } catch (error) {
    throw new TonDomainError('INVALID_PROOF', 'Proof signature is invalid', { cause: error });
  }
  if (signature.length !== 64) {
    throw new TonDomainError('INVALID_PROOF', 'Proof signature is invalid');
  }
  return signature;
}

function assertProofShape(proof: TonProofObject): void {
  if (
    proof === null ||
    typeof proof !== 'object' ||
    typeof proof.timestamp !== 'number' ||
    !Number.isFinite(proof.timestamp) ||
    proof.domain === null ||
    typeof proof.domain !== 'object' ||
    typeof proof.domain.value !== 'string' ||
    typeof proof.domain.lengthBytes !== 'number' ||
    typeof proof.payload !== 'string' ||
    typeof proof.signature !== 'string'
  ) {
    throw new TonDomainError('INVALID_PROOF', 'Proof is malformed');
  }
}

/**
 * Official TON Connect ton_proof verification.
 * Does not invent serialization. Network acceptance is checked separately from crypto.
 */
export function verifyTonProof(input: VerifyTonProofInput): VerifiedTonProof {
  assertProofShape(input.proof);

  if (input.expectedDomain.trim() === '') {
    throw new TonDomainError('INVALID_DOMAIN', 'Expected proof domain is not configured');
  }
  if (input.proof.domain.value !== input.expectedDomain) {
    throw new TonDomainError('INVALID_DOMAIN', 'Proof domain is not accepted');
  }
  const domainBytes = Buffer.byteLength(input.proof.domain.value, 'utf8');
  if (input.proof.domain.lengthBytes !== domainBytes) {
    throw new TonDomainError('INVALID_DOMAIN', 'Proof domain length does not match domain value');
  }

  const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (input.proof.timestamp > now + input.maxFutureSkewSeconds) {
    throw new TonDomainError('FUTURE_PROOF', 'Proof timestamp is not acceptable');
  }
  if (now - input.proof.timestamp > input.maxAgeSeconds) {
    throw new TonDomainError('STALE_PROOF', 'Proof timestamp is not acceptable');
  }

  if (input.proof.payload !== input.expectedPayload) {
    throw new TonDomainError('INVALID_PROOF', 'Proof payload does not match challenge');
  }

  const network = input.account.network.trim();
  if (network !== input.expectedNetwork) {
    throw new TonDomainError('INVALID_NETWORK', 'TON network is not accepted');
  }
  if (network !== '-239' && network !== '-3') {
    throw new TonDomainError('INVALID_NETWORK', 'TON network is not accepted');
  }

  const canonical = parseTonConnectAccountAddress(input.account.address);
  const stateInitBase64 = resolveStateInitBase64(input.proof, input.account);
  const stateInit = parseStateInitFromBase64(stateInitBase64);
  assertStateInitMatchesAddress(stateInit, canonical.addressHash);
  const publicKey = extractPublicKeyFromStateInit(stateInit);

  if (typeof input.account.publicKey === 'string' && input.account.publicKey.trim() !== '') {
    const claimed = Buffer.from(input.account.publicKey.trim(), 'hex');
    if (claimed.length !== 32 || !claimed.equals(publicKey)) {
      throw new TonDomainError('INVALID_WALLET', 'Wallet public key does not match account state');
    }
  }

  const digest = buildTonProofSigningDigest({
    workchain: canonical.workchain,
    addressHash: canonical.addressHash,
    domainValue: input.proof.domain.value,
    domainLengthBytes: input.proof.domain.lengthBytes,
    timestamp: Math.trunc(input.proof.timestamp),
    payload: input.proof.payload,
  });

  const signature = decodeSignature(input.proof.signature);
  const ok = signVerify(digest, signature, publicKey);
  if (!ok) {
    throw new TonDomainError('INVALID_PROOF', 'Proof signature is invalid');
  }

  return {
    canonical,
    publicKeyHex: publicKey.toString('hex'),
    network,
    proofTimestamp: Math.trunc(input.proof.timestamp),
  };
}

/** Map authoritative networks.global_chain_identifier to TON Connect network id. */
export function tonConnectNetworkFromGlobalChainIdentifier(
  globalChainIdentifier: string,
): TonConnectNetworkId {
  const value = globalChainIdentifier.trim().toLowerCase();
  if (value === 'ton:testnet' || value === 'ton:-3' || value === '-3') return '-3';
  if (value === 'ton:mainnet' || value === 'ton:-239' || value === '-239') return '-239';
  throw new TonDomainError('INVALID_NETWORK', 'TON network is not accepted', {
    details: { globalChainIdentifier },
  });
}
