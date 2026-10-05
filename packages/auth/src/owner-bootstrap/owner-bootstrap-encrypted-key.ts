/**
 * Encrypted-at-rest production Owner-bootstrap Ed25519 key (Phase 21 Step 4A.2).
 * KDF: Argon2id. AEAD: XChaCha20-Poly1305. Never write plaintext private seed files.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from '@noble/hashes/argon2.js';

import { AuthDomainError } from '../errors.js';
import { bytesToHex, generateEd25519KeyPair, publicKeyFromPrivateSeed } from './ed25519.js';
import { fingerprintPublicKey } from './grant.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

export const OWNER_BOOTSTRAP_KEY_BUNDLE_FORMAT = 1 as const;
export const OWNER_BOOTSTRAP_KEY_PURPOSE = 'OWNER_BOOTSTRAP_ED25519_V1' as const;
export const OWNER_BOOTSTRAP_KEY_KDF = 'argon2id' as const;
export const OWNER_BOOTSTRAP_KEY_AEAD = 'xchacha20poly1305' as const;

const AEAD_KEY_BYTES = 32 as const;
const DEFAULT_KDF = { memory: 65_536, passes: 3, parallelism: 1, dkLen: AEAD_KEY_BYTES } as const;

export interface OwnerBootstrapEncryptedKeyBundleV1 {
  readonly formatVersion: typeof OWNER_BOOTSTRAP_KEY_BUNDLE_FORMAT;
  readonly purpose: typeof OWNER_BOOTSTRAP_KEY_PURPOSE;
  readonly trust_class: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly key_id: string;
  readonly kdf: typeof OWNER_BOOTSTRAP_KEY_KDF;
  readonly kdfParams: {
    readonly memory: number;
    readonly passes: number;
    readonly parallelism: number;
    readonly dkLen: number;
  };
  readonly saltB64: string;
  readonly aead: typeof OWNER_BOOTSTRAP_KEY_AEAD;
  readonly nonceB64: string;
  readonly ciphertextB64: string;
  readonly public_key_raw_hex: string;
  readonly public_key_sha256_hex: string;
  readonly created_unix: number;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new AuthDomainError('VALIDATION', 'Owner bootstrap passphrase must be at least 16 characters');
  }
}

function deriveKey(passphrase: string, salt: Uint8Array, params: {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly dkLen: number;
}): Uint8Array {
  return argon2id(passphrase, salt, {
    t: params.passes,
    m: params.memory,
    p: params.parallelism,
    dkLen: params.dkLen,
  });
}

const FORBIDDEN_SYNC_DIR =
  /(onedrive|dropbox|google drive|googledrive|icloud|box sync|mega\\cloud)/i;

export function assertOwnerBootstrapCeremonyDirSafe(ceremonyDir: string, repoRootHint: string): void {
  const dir = resolve(ceremonyDir).toLowerCase();
  const repo = resolve(repoRootHint).toLowerCase();
  if (dir === repo || dir.startsWith(repo + '\\') || dir.startsWith(repo + '/')) {
    throw new AuthDomainError('FORBIDDEN', 'production ceremony directory must be outside the git repository');
  }
  const allowTestTemp =
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS === '1' &&
    process.env.ALEX_OWNER_BOOTSTRAP_ALLOW_TEST_TEMP_DIR === '1';
  const tmp = resolve(process.env.TEMP ?? process.env.TMP ?? '/tmp').toLowerCase();
  if (
    !allowTestTemp &&
    (dir === tmp || dir.startsWith(tmp + '\\') || dir.startsWith(tmp + '/'))
  ) {
    throw new AuthDomainError('FORBIDDEN', 'production ceremony directory must not be a temp directory');
  }
  if (FORBIDDEN_SYNC_DIR.test(dir)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production Owner bootstrap key directory must not be a cloud-sync folder (OneDrive/Dropbox/Google Drive)',
    );
  }
}

export function encryptOwnerBootstrapPrivateSeed(input: {
  readonly seed32: Uint8Array;
  readonly passphrase: string;
  readonly keyId: string;
  readonly kdfParams?: {
    readonly memory: number;
    readonly passes: number;
    readonly parallelism: number;
    readonly dkLen: number;
  };
}): OwnerBootstrapEncryptedKeyBundleV1 {
  assertPassphrase(input.passphrase);
  if (input.seed32.byteLength !== 32) {
    throw new AuthDomainError('VALIDATION', 'Ed25519 seed must be 32 bytes');
  }
  const kdfParams = input.kdfParams ?? { ...DEFAULT_KDF };
  if (kdfParams.dkLen !== AEAD_KEY_BYTES) {
    throw new AuthDomainError('VALIDATION', 'dkLen must be 32 for XChaCha20-Poly1305');
  }
  const publicKey = publicKeyFromPrivateSeed(input.seed32);
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = deriveKey(input.passphrase, salt, kdfParams);
  const aead = xchacha20poly1305(key, nonce);
  const ciphertext = aead.encrypt(input.seed32);
  key.fill(0);
  return {
    formatVersion: OWNER_BOOTSTRAP_KEY_BUNDLE_FORMAT,
    purpose: OWNER_BOOTSTRAP_KEY_PURPOSE,
    trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    key_id: input.keyId,
    kdf: OWNER_BOOTSTRAP_KEY_KDF,
    kdfParams,
    saltB64: b64(salt),
    aead: OWNER_BOOTSTRAP_KEY_AEAD,
    nonceB64: b64(nonce),
    ciphertextB64: b64(ciphertext),
    public_key_raw_hex: bytesToHex(publicKey),
    public_key_sha256_hex: fingerprintPublicKey(publicKey),
    created_unix: Math.floor(Date.now() / 1000),
  };
}

export function decryptOwnerBootstrapPrivateSeed(
  bundle: OwnerBootstrapEncryptedKeyBundleV1,
  passphrase: string,
): Uint8Array {
  assertPassphrase(passphrase);
  if (bundle.formatVersion !== 1 || bundle.purpose !== OWNER_BOOTSTRAP_KEY_PURPOSE) {
    throw new AuthDomainError('FORBIDDEN', 'unsupported Owner bootstrap key bundle');
  }
  if (bundle.kdf !== OWNER_BOOTSTRAP_KEY_KDF || bundle.aead !== OWNER_BOOTSTRAP_KEY_AEAD) {
    throw new AuthDomainError('FORBIDDEN', 'unsupported KDF/AEAD');
  }
  const salt = fromB64(bundle.saltB64);
  const nonce = fromB64(bundle.nonceB64);
  const ciphertext = fromB64(bundle.ciphertextB64);
  const key = deriveKey(passphrase, salt, bundle.kdfParams);
  try {
    const aead = xchacha20poly1305(key, nonce);
    const seed = aead.decrypt(ciphertext);
    if (seed.byteLength !== 32) {
      throw new AuthDomainError('FORBIDDEN', 'decrypted seed length invalid');
    }
    const pub = publicKeyFromPrivateSeed(seed);
    if (bytesToHex(pub) !== bundle.public_key_raw_hex) {
      throw new AuthDomainError('FORBIDDEN', 'decrypted key does not match bundle public key');
    }
    if (fingerprintPublicKey(pub) !== bundle.public_key_sha256_hex) {
      throw new AuthDomainError('FORBIDDEN', 'decrypted key fingerprint mismatch');
    }
    return seed;
  } catch (error) {
    if (error instanceof AuthDomainError) throw error;
    throw new AuthDomainError('FORBIDDEN', 'Owner bootstrap key decrypt failed (wrong passphrase or tamper)');
  } finally {
    key.fill(0);
  }
}

export function zeroizeBytes(buf: Uint8Array): void {
  buf.fill(0);
}

export function writeEncryptedOwnerBootstrapKeyBundle(input: {
  readonly ceremonyDir: string;
  readonly bundle: OwnerBootstrapEncryptedKeyBundleV1;
  readonly filename?: string;
}): { readonly path: string; readonly ciphertextSha256Hex: string } {
  const dir = resolve(input.ceremonyDir);
  mkdirSync(dir, { recursive: true });
  const name =
    input.filename ??
    `owner-bootstrap-production-${new Date().toISOString().replace(/[:.]/g, '-')}.enc`;
  if (!name.endsWith('.enc')) {
    throw new AuthDomainError('VALIDATION', 'encrypted Owner key filename must end with .enc');
  }
  if (name.toLowerCase().includes('seed.hex') || name.toLowerCase().endsWith('.hex')) {
    throw new AuthDomainError('FORBIDDEN', 'plaintext .hex private seed filenames are forbidden');
  }
  const path = join(dir, basename(name));
  if (existsSync(path)) {
    throw new AuthDomainError('FORBIDDEN', 'refusing to overwrite existing encrypted Owner key bundle');
  }
  const body = JSON.stringify(input.bundle, null, 2) + '\n';
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on Windows
  }
  const ciphertextSha256Hex = createHash('sha256')
    .update(input.bundle.ciphertextB64, 'utf8')
    .digest('hex');
  return { path, ciphertextSha256Hex };
}

export function generateEncryptedProductionOwnerBootstrapKey(input: {
  readonly ceremonyDir: string;
  readonly keyId: string;
  readonly passphrase: string;
  readonly passphraseConfirm: string;
  readonly phase21ProductionOwnerBootstrap: boolean;
  readonly requireInteractiveTty?: boolean;
  readonly repoRootHint: string;
  /** Test-only fast KDF when ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1. */
  readonly testFastKdf?: boolean;
}): {
  readonly publicRecord: {
    readonly trust_class: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
    readonly key_id: string;
    readonly alg: 'Ed25519';
    readonly public_key_raw_hex: string;
    readonly public_key_sha256_hex: string;
    readonly created_unix: number;
    readonly encrypted_bundle_path_basename: string;
    readonly ciphertext_sha256_hex: string;
    readonly warning: string;
  };
  readonly encryptedBundlePath: string;
} {
  if (input.phase21ProductionOwnerBootstrap !== true) {
    throw new AuthDomainError('FORBIDDEN', 'generate-keypair requires --phase21-production-owner-bootstrap');
  }
  const requireTty = input.requireInteractiveTty !== false;
  if (requireTty) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'INTERACTIVE_TTY_REQUIRED for production Owner-bootstrap key generation',
      );
    }
  } else if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError('FORBIDDEN', 'TTY bypass only allowed with ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1');
  }
  if (process.env.PASSWORD || process.env.OWNER_BOOTSTRAP_PASSPHRASE || process.env.TOTP) {
    throw new AuthDomainError('FORBIDDEN', 'passphrase/secret via env forbidden');
  }
  if (input.passphrase !== input.passphraseConfirm) {
    throw new AuthDomainError('VALIDATION', 'passphrase confirmation mismatch');
  }
  assertOwnerBootstrapCeremonyDirSafe(input.ceremonyDir, input.repoRootHint);
  const kp = generateEd25519KeyPair();
  const seed = new Uint8Array(kp.privateKey);
  const kdfParams =
    input.testFastKdf === true && process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS === '1'
      ? { memory: 16, passes: 1, parallelism: 1, dkLen: AEAD_KEY_BYTES }
      : { ...DEFAULT_KDF };
  try {
    const bundle = encryptOwnerBootstrapPrivateSeed({
      seed32: seed,
      passphrase: input.passphrase,
      keyId: input.keyId,
      kdfParams,
    });
    const written = writeEncryptedOwnerBootstrapKeyBundle({
      ceremonyDir: input.ceremonyDir,
      bundle,
    });
    const pubPath = join(resolve(input.ceremonyDir), 'bootstrap-public.json');
    const publicRecord = {
      trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      key_id: input.keyId,
      alg: 'Ed25519' as const,
      public_key_raw_hex: bundle.public_key_raw_hex,
      public_key_sha256_hex: bundle.public_key_sha256_hex,
      created_unix: bundle.created_unix,
      encrypted_bundle_path_basename: basename(written.path),
      ciphertext_sha256_hex: written.ciphertextSha256Hex,
      warning:
        'ENCRYPTED PRIVATE KEY ONLY — never plaintext seed; never reuse Hot Wallet keys; keep >=2 offline ciphertext backups with separate passphrase storage',
    };
    writeFileSync(pubPath, JSON.stringify(publicRecord, null, 2) + '\n', { encoding: 'utf8' });
    return { publicRecord, encryptedBundlePath: written.path };
  } finally {
    zeroizeBytes(seed);
    zeroizeBytes(kp.privateKey);
  }
}

export function assertNoPlaintextOwnerBootstrapSeedFile(ceremonyDir: string): void {
  const dir = resolve(ceremonyDir);
  for (const name of ['bootstrap-private-seed.hex', 'owner-bootstrap-private-seed.hex']) {
    if (existsSync(join(dir, name))) {
      throw new AuthDomainError('FORBIDDEN', `plaintext private seed file forbidden: ${name}`);
    }
  }
}
