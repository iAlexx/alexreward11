import { createHmac, timingSafeEqual } from 'node:crypto';

import { AuthDomainError } from './errors.js';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly typ: 'access';
  readonly iat: number;
  readonly exp: number;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function issueAccessToken(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly nowUnixSeconds?: number;
}): { readonly token: string; readonly expiresAt: Date } {
  const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + input.ttlSeconds;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        sub: input.userId,
        sid: input.sessionId,
        typ: 'access',
        iat: now,
        exp,
      } satisfies AccessTokenClaims),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', input.secret).update(signingInput).digest('base64url');
  return {
    token: `${signingInput}.${signature}`,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyAccessToken(
  token: string,
  secret: string,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }
  const [header, payload, signature] = parts;
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }
  const signingInput = `${header}.${payload}`;
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(signature);
  } catch {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString('utf8')) as AccessTokenClaims;
  } catch {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }
  if (
    claims.typ !== 'access' ||
    typeof claims.sub !== 'string' ||
    typeof claims.sid !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  ) {
    throw new AuthDomainError('INVALID_TOKEN', 'Access session is invalid');
  }
  if (claims.exp <= nowUnixSeconds) {
    throw new AuthDomainError('SESSION_EXPIRED', 'Access session expired');
  }
  return claims;
}
