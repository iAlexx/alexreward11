/**
 * RFC 6238 TOTP (SHA-1, 30s, 6 digits) for Owner admin second factor.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/sha1.js';

import { AuthDomainError } from './errors.js';
import { safeEqualString } from './crypto.js';

export const ADMIN_TOTP_DIGITS = 6 as const;
export const ADMIN_TOTP_PERIOD_SECONDS = 30 as const;
export const ADMIN_TOTP_WINDOW = 1 as const; // ±1 step

function hotp(secret: Uint8Array, counter: bigint): string {
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const digest = hmac(sha1, secret, buf);
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const otp = binary % 10 ** ADMIN_TOTP_DIGITS;
  return String(otp).padStart(ADMIN_TOTP_DIGITS, '0');
}

export function generateTotpCode(
  secret: Uint8Array,
  atMs: number = Date.now(),
): string {
  const counter = BigInt(Math.floor(atMs / 1000 / ADMIN_TOTP_PERIOD_SECONDS));
  return hotp(secret, counter);
}

/** Returns the matched TOTP counter (time step) or null if invalid. */
export function verifyTotpCodeWithStep(
  secret: Uint8Array,
  code: string,
  atMs: number = Date.now(),
  window: number = ADMIN_TOTP_WINDOW,
): bigint | null {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) {
    return null;
  }
  const counter = BigInt(Math.floor(atMs / 1000 / ADMIN_TOTP_PERIOD_SECONDS));
  for (let delta = -window; delta <= window; delta += 1) {
    const step = counter + BigInt(delta);
    const candidate = hotp(secret, step);
    if (safeEqualString(candidate, normalized)) return step;
  }
  return null;
}

export function verifyTotpCode(
  secret: Uint8Array,
  code: string,
  atMs: number = Date.now(),
  window: number = ADMIN_TOTP_WINDOW,
): boolean {
  return verifyTotpCodeWithStep(secret, code, atMs, window) !== null;
}

export function totpStepAt(atMs: number = Date.now()): bigint {
  return BigInt(Math.floor(atMs / 1000 / ADMIN_TOTP_PERIOD_SECONDS));
}

export function buildOtpAuthUri(input: {
  readonly secretBase32: string;
  readonly accountName: string;
  readonly issuer?: string;
}): string {
  const issuer = input.issuer ?? 'ALEx Rewards';
  const label = encodeURIComponent(`${issuer}:${input.accountName}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(ADMIN_TOTP_DIGITS),
    period: String(ADMIN_TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function assertTotpCodeFormat(code: string): void {
  if (!/^\d{6}$/.test(code.trim())) {
    throw new AuthDomainError('VALIDATION', 'TOTP code must be 6 digits');
  }
}
