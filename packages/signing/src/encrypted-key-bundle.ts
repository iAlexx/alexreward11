/**
 * Authenticated encrypted Ed25519 Hot Wallet key bundle (v1).
 * KDF: Argon2id. AEAD: XChaCha20-Poly1305. No custom cryptography.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { keyPairFromSeed } from '@ton/crypto';

import { SignerError } from './errors.js';
import { deriveWalletV5R1 } from './wallet-v5r1.js';

export const KEY_BUNDLE_FORMAT_VERSION = 1 as const;
export const KEY_BUNDLE_KDF = 'argon2id' as const;
export const KEY_BUNDLE_AEAD = 'xchacha20poly1305' as const;

/** Memory-hard defaults suitable for interactive unlock (tunable via versioned params). */
export const DEFAULT_ARGON2ID_PARAMS = {
  memory: 65_536, // KiB (~64 MiB)
  passes: 3,
  parallelism: 1,
  dkLen: 32,
} as const;

export interface KeyBundleKdfParams {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly dkLen: number;
}

export interface EncryptedKeyBundleV1 {
  readonly formatVersion: typeof KEY_BUNDLE_FORMAT_VERSION;
  readonly kdf: typeof KEY_BUNDLE_KDF;
  readonly kdfParams: KeyBundleKdfParams;
  readonly saltB64: string;
  readonly aead: typeof KEY_BUNDLE_AEAD;
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly publicKeyFingerprint: string;
  readonly networkGlobalId: number;
  readonly walletVersion: 'v5R1';
  readonly workchain: number;
  readonly derivedAddressRaw: string;
}

export interface GeneratedHotWalletIdentity {
  readonly publicKey: Buffer;
  readonly publicKeyFingerprint: string;
  readonly addressRaw: string;
  readonly addressFriendly: string;
  readonly networkGlobalId: number;
  readonly workchain: number;
  readonly walletVersion: 'v5R1';
}

function b64(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString('base64');
}

function fromB64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

export function publicKeyFingerprintHex(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  params: KeyBundleKdfParams,
): Uint8Array {
  const pass = Buffer.from(passphrase, 'utf8');
  return argon2id(pass, salt, {
    t: params.passes,
    m: params.memory,
    p: params.parallelism,
    dkLen: params.dkLen,
  });
}

function assertPassphraseStrength(passphrase: string): void {
  if (passphrase.length < 16) {
    throw new SignerError('KEY_DECRYPT_FAILED', 'Passphrase must be at least 16 characters');
  }
}

export function generateHotWalletSeed(): Buffer {
  return randomBytes(32);
}

export function identityFromSeed(
  seed: Buffer,
  opts: { networkGlobalId: number; workchain: number } = { networkGlobalId: -3, workchain: 0 },
): GeneratedHotWalletIdentity {
  if (seed.length !== 32) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Ed25519 seed must be 32 bytes');
  }
  if (opts.networkGlobalId === -239) {
    throw new SignerError('MAINNET_REJECTED', 'MAINNET key generation is forbidden in Phase 9');
  }
  const keyPair = keyPairFromSeed(seed);
  const publicKey = Buffer.from(keyPair.publicKey);
  const derived = deriveWalletV5R1({
    publicKey,
    networkGlobalId: opts.networkGlobalId,
    workchain: opts.workchain,
  });
  return {
    publicKey,
    publicKeyFingerprint: publicKeyFingerprintHex(publicKey),
    addressRaw: derived.addressRaw,
    addressFriendly: derived.addressFriendly,
    networkGlobalId: opts.networkGlobalId,
    workchain: opts.workchain,
    walletVersion: 'v5R1',
  };
}

export function encryptKeyBundle(input: {
  readonly seed: Buffer;
  readonly passphrase: string;
  readonly networkGlobalId?: number;
  readonly workchain?: number;
  readonly kdfParams?: KeyBundleKdfParams;
}): EncryptedKeyBundleV1 {
  assertPassphraseStrength(input.passphrase);
  const networkGlobalId = input.networkGlobalId ?? -3;
  const workchain = input.workchain ?? 0;
  const identity = identityFromSeed(input.seed, { networkGlobalId, workchain });
  const kdfParams = input.kdfParams ?? { ...DEFAULT_ARGON2ID_PARAMS };
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = deriveWrappingKey(input.passphrase, salt, kdfParams);
  const aead = xchacha20poly1305(key, nonce);
  const ciphertext = aead.encrypt(input.seed);
  return {
    formatVersion: KEY_BUNDLE_FORMAT_VERSION,
    kdf: KEY_BUNDLE_KDF,
    kdfParams,
    saltB64: b64(salt),
    aead: KEY_BUNDLE_AEAD,
    nonceB64: b64(nonce),
    ciphertextB64: b64(ciphertext),
    publicKeyFingerprint: identity.publicKeyFingerprint,
    networkGlobalId,
    walletVersion: 'v5R1',
    workchain,
    derivedAddressRaw: identity.addressRaw,
  };
}

function parseBundle(raw: unknown): EncryptedKeyBundleV1 {
  if (raw === null || typeof raw !== 'object') {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Malformed key bundle');
  }
  const o = raw as Record<string, unknown>;
  if (o.formatVersion !== KEY_BUNDLE_FORMAT_VERSION) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Unsupported key bundle format version', {
      formatVersion: o.formatVersion,
    });
  }
  if (o.kdf !== KEY_BUNDLE_KDF || o.aead !== KEY_BUNDLE_AEAD) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Unsupported KDF or AEAD in key bundle');
  }
  if (
    typeof o.saltB64 !== 'string' ||
    typeof o.nonceB64 !== 'string' ||
    typeof o.ciphertextB64 !== 'string'
  ) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle missing required ciphertext fields');
  }
  if (typeof o.publicKeyFingerprint !== 'string' || typeof o.derivedAddressRaw !== 'string') {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle missing identity metadata');
  }
  if (
    o.walletVersion !== 'v5R1' ||
    typeof o.networkGlobalId !== 'number' ||
    typeof o.workchain !== 'number'
  ) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle wallet/network metadata invalid');
  }
  const kdfParams = o.kdfParams;
  if (kdfParams === null || typeof kdfParams !== 'object') {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle missing KDF params');
  }
  const kp = kdfParams as Record<string, unknown>;
  if (
    typeof kp.memory !== 'number' ||
    typeof kp.passes !== 'number' ||
    typeof kp.parallelism !== 'number' ||
    typeof kp.dkLen !== 'number'
  ) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle KDF params invalid');
  }
  return {
    formatVersion: KEY_BUNDLE_FORMAT_VERSION,
    kdf: KEY_BUNDLE_KDF,
    kdfParams: {
      memory: kp.memory,
      passes: kp.passes,
      parallelism: kp.parallelism,
      dkLen: kp.dkLen,
    },
    saltB64: o.saltB64,
    aead: KEY_BUNDLE_AEAD,
    nonceB64: o.nonceB64,
    ciphertextB64: o.ciphertextB64,
    publicKeyFingerprint: o.publicKeyFingerprint,
    networkGlobalId: o.networkGlobalId,
    walletVersion: 'v5R1',
    workchain: o.workchain,
    derivedAddressRaw: o.derivedAddressRaw,
  };
}

export function loadKeyBundleFile(path: string): EncryptedKeyBundleV1 {
  if (!existsSync(path)) {
    throw new SignerError('KEY_BUNDLE_MISSING', 'Encrypted key bundle file not found', { path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Key bundle file is not valid JSON');
  }
  return parseBundle(parsed);
}

export function writeKeyBundleFile(path: string, bundle: EncryptedKeyBundleV1): void {
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  // Fail closed if plaintext seed somehow appeared
  if (/mnemonic|private[_ ]?key|BEGIN PRIVATE/i.test(json)) {
    throw new SignerError(
      'KEY_BUNDLE_INVALID',
      'Refusing to write bundle that looks like plaintext secret',
    );
  }
  writeFileSync(path, json, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may ignore mode; best-effort.
  }
}

export interface DecryptedSigningMaterial {
  readonly seed: Buffer;
  readonly secretKey: Buffer;
  readonly publicKey: Buffer;
  readonly publicKeyFingerprint: string;
  readonly addressRaw: string;
  readonly networkGlobalId: number;
  readonly workchain: number;
}

export function decryptKeyBundle(
  bundle: EncryptedKeyBundleV1,
  passphrase: string,
): DecryptedSigningMaterial {
  // Re-validate shape (defense in depth for in-memory / mutated objects)
  const validated = parseBundle(bundle);
  assertPassphraseStrength(passphrase);
  const salt = fromB64(validated.saltB64);
  const nonce = fromB64(validated.nonceB64);
  const ciphertext = fromB64(validated.ciphertextB64);
  if (nonce.length !== 24) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Invalid AEAD nonce length');
  }
  const key = deriveWrappingKey(passphrase, salt, validated.kdfParams);
  const aead = xchacha20poly1305(key, nonce);
  let seedBytes: Uint8Array;
  try {
    seedBytes = aead.decrypt(ciphertext);
  } catch {
    throw new SignerError('KEY_DECRYPT_FAILED', 'Key bundle authentication/decryption failed');
  }
  const seed = Buffer.from(seedBytes);
  if (seed.length !== 32) {
    throw new SignerError('KEY_BUNDLE_INVALID', 'Decrypted seed length invalid');
  }
  const identity = identityFromSeed(seed, {
    networkGlobalId: validated.networkGlobalId,
    workchain: validated.workchain,
  });
  if (identity.publicKeyFingerprint !== validated.publicKeyFingerprint) {
    throw new SignerError('KEY_IDENTITY_MISMATCH', 'Decrypted public key fingerprint mismatch');
  }
  if (identity.addressRaw !== validated.derivedAddressRaw) {
    throw new SignerError('KEY_IDENTITY_MISMATCH', 'Decrypted Wallet V5 R1 address mismatch');
  }
  if (validated.networkGlobalId === -239) {
    throw new SignerError('MAINNET_REJECTED', 'MAINNET bundles are forbidden in Phase 9');
  }
  const keyPair = keyPairFromSeed(seed);
  return {
    seed,
    secretKey: Buffer.from(keyPair.secretKey),
    publicKey: Buffer.from(keyPair.publicKey),
    publicKeyFingerprint: identity.publicKeyFingerprint,
    addressRaw: identity.addressRaw,
    networkGlobalId: validated.networkGlobalId,
    workchain: validated.workchain,
  };
}

/** Best-effort overwrite of Buffer contents (JS cannot guarantee perfect zeroization). */
export function scrubBuffer(buf: Buffer | undefined): void {
  if (buf === undefined) return;
  buf.fill(0);
}
