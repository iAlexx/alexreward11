import type { Redis } from 'ioredis';

import { AuthDomainError } from './errors.js';

export interface ThrottlePolicy {
  readonly keyPrefix: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Redis-assisted fixed-window throttle. PostgreSQL remains authoritative for sessions/claims;
 * Redis only limits abuse. Fail-open is forbidden for claim/auth when Redis is required —
 * callers may choose fail-closed by not catching.
 */
export async function consumeThrottle(
  redis: Redis,
  policy: ThrottlePolicy,
  identityKey: string,
): Promise<void> {
  const key = `${policy.keyPrefix}:${identityKey}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, policy.windowSeconds);
  }
  if (count > policy.limit) {
    throw new AuthDomainError('RATE_LIMITED', 'Too many attempts. Try again later.');
  }
}
