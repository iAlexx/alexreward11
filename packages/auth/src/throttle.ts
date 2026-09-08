import type { Redis } from 'ioredis';

import { AuthDomainError } from './errors.js';

export interface ThrottlePolicy {
  readonly keyPrefix: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Redis-assisted fixed-window throttle. PostgreSQL remains authoritative for sessions/claims;
 * Redis only limits abuse. Failures are fail-closed: never silently allow traffic when Redis
 * is unavailable.
 */
export async function consumeThrottle(
  redis: Redis,
  policy: ThrottlePolicy,
  identityKey: string,
): Promise<void> {
  try {
    const key = `${policy.keyPrefix}:${identityKey}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, policy.windowSeconds);
    }
    if (count > policy.limit) {
      throw new AuthDomainError('RATE_LIMITED', 'Too many attempts. Try again later.');
    }
  } catch (error) {
    if (error instanceof AuthDomainError) throw error;
    throw new AuthDomainError('INTERNAL', 'Abuse protection unavailable', { cause: error });
  }
}
