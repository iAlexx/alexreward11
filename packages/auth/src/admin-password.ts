/**
 * Owner admin password verifiers (Argon2id) and local TOTP seal format.
 * Password verifiers are safe to store. TOTP secrets are AEAD-sealed under a
 * password-derived key so plaintext TOTP never rests in PostgreSQL.
 */
import { randomBytes } from 'node:crypto';

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { AuthDomainError } from './errors.js';
import { safeEqualString } from './crypto.js';

/** @noble/hashes Argon2id: t=time, m=memory KiB, p=parallelism */
export const ADMIN_PASSWORD_ARGON2 = {
  t: 3,
  m: 65_536,
  p: 1,
  dkLen: 32,
} as const;

const VERIFIER_PREFIX = 'argon2id-v1' as const;
const TOTP_SEAL_PREFIX = 'local-totp-seal-v1' as const;

function encodeB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeB64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < 12) {
    throw new AuthDomainError('VALIDATION', 'password must be at least 12 characters');
  }
  if (password.length > 200) {
    throw new AuthDomainError('VALIDATION', 'password exceeds maximum length');
  }
  if (/^\s|\s$/.test(password)) {
    throw new AuthDomainError('VALIDATION', 'password must not start or end with whitespace');
  }
}

export async function hashAdminPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const hash = argon2id(password, salt, { ...ADMIN_PASSWORD_ARGON2 });
  return [
    VERIFIER_PREFIX,
    `m=${ADMIN_PASSWORD_ARGON2.m}`,
    `t=${ADMIN_PASSWORD_ARGON2.t}`,
    `p=${ADMIN_PASSWORD_ARGON2.p}`,
    encodeB64Url(salt),
    encodeB64Url(hash),
  ].join('$');
}

export async function verifyAdminPassword(
  password: string,
  storedVerifier: string,
): Promise<boolean> {
  const parts = storedVerifier.split('$');
  if (parts.length !== 6 || parts[0] !== VERIFIER_PREFIX) {
    return false;
  }
  const memory = Number(parts[1]?.replace(/^m=/, ''));
  const passes = Number(parts[2]?.replace(/^t=/, ''));
  const parallelism = Number(parts[3]?.replace(/^p=/, ''));
  const salt = decodeB64Url(parts[4] ?? '');
  const expected = decodeB64Url(parts[5] ?? '');
  if (
    !Number.isFinite(memory) ||
    !Number.isFinite(passes) ||
    !Number.isFinite(parallelism) ||
    salt.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }
  const actual = argon2id(password, salt, {
    m: memory,
    t: passes,
    p: parallelism,
    dkLen: expected.length,
  });
  if (actual.length !== expected.length) return false;
  // Constant-time compare via hex strings of equal length
  return safeEqualString(bytesToHex(actual), bytesToHex(expected));
}

function deriveTotpSealKey(password: string, salt: Uint8Array): Uint8Array {
  return argon2id(password, salt, { ...ADMIN_PASSWORD_ARGON2, dkLen: 32 });
}

/** Seal TOTP shared secret for storage in admin_credentials.totp_secret_reference. */
export function sealTotpSecret(password: string, totpSecretBytes: Uint8Array): string {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const key = deriveTotpSealKey(password, salt);
  const nonce = randomBytes(24);
  const aead = xchacha20poly1305(key, nonce);
  const ciphertext = aead.encrypt(totpSecretBytes);
  return [
    TOTP_SEAL_PREFIX,
    encodeB64Url(salt),
    encodeB64Url(nonce),
    encodeB64Url(ciphertext),
  ].join('$');
}

export function unsealTotpSecret(password: string, sealed: string): Uint8Array {
  const parts = sealed.split('$');
  if (parts.length !== 4 || parts[0] !== TOTP_SEAL_PREFIX) {
    throw new AuthDomainError('UNAUTHENTICATED', 'invalid credential material');
  }
  const salt = decodeB64Url(parts[1] ?? '');
  const nonce = decodeB64Url(parts[2] ?? '');
  const ciphertext = decodeB64Url(parts[3] ?? '');
  const key = deriveTotpSealKey(password, salt);
  try {
    const aead = xchacha20poly1305(key, nonce);
    return aead.decrypt(ciphertext);
  } catch {
    throw new AuthDomainError('UNAUTHENTICATED', 'invalid credentials');
  }
}

export function isLocalTotpSealReference(reference: string): boolean {
  return reference.startsWith(`${TOTP_SEAL_PREFIX}$`);
}

/** Encode raw bytes as base32 (RFC 4648) for authenticator apps. */
export function bytesToBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32ToBytes(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.replace(/=+$/g, '').toUpperCase().replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) {
      throw new AuthDomainError('VALIDATION', 'invalid base32 secret');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function generateTotpSecretBytes(byteLength = 20): Uint8Array {
  return randomBytes(byteLength);
}

export { hexToBytes, bytesToHex };
