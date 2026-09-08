import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashSessionSecret(raw: string): string {
  return sha256Hex(`session:${raw}`);
}

export function hashRefreshToken(raw: string): string {
  return sha256Hex(`refresh:${raw}`);
}

export function hashClaimCode(raw: string): string {
  return sha256Hex(`claim:${raw.trim()}`);
}

export function hashIp(ip: string | null | undefined): string | null {
  if (ip === undefined || ip === null || ip.trim() === '') return null;
  return sha256Hex(`ip:${ip.trim()}`);
}

export function summarizeUserAgent(userAgent: string | null | undefined): string | null {
  if (userAgent === undefined || userAgent === null) return null;
  const trimmed = userAgent.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, 180);
}

/** Cryptographically unpredictable Founder claim source code (never logged). */
export function generateClaimCode(length = 24): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += CLAIM_CODE_ALPHABET[byte % CLAIM_CODE_ALPHABET.length] ?? 'A';
  }
  return out;
}

export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const SENSITIVE_KEY =
  /(initdata|token|secret|password|authorization|refresh|claim.?code|cookie|bot.?token)/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(nested);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 64 && /[A-Za-z0-9_-]{40,}/.test(value)) {
    return '[REDACTED]';
  }
  return value;
}
