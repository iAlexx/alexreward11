/**
 * Phase 3 rate-limit / brute-force proof suite.
 *
 * Exercises consumeThrottle against real Redis (CI service or local).
 * PostgreSQL remains authoritative for sessions/claims; Redis only throttles abuse.
 *
 * Requires:
 *   PHASE3_REDIS_URL or (PHASE3_AUTH_TESTS=1 + REDIS_URL)
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consumeThrottle } from '../src/index.js';

const explicitRedis = process.env.PHASE3_REDIS_URL ?? '';
const optedInRedis = process.env.PHASE3_AUTH_TESTS === '1' ? (process.env.REDIS_URL ?? '') : '';
const redisUrl = explicitRedis !== '' ? explicitRedis : optedInRedis;

const AUTH_PREFIX = 'throttle:auth:telegram';
const REFRESH_PREFIX = 'throttle:auth:refresh';
const CLAIM_PREFIX = 'throttle:membership:claim';

describe.skipIf(redisUrl === '')('Phase 3 throttle / brute-force controls', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const authKeys = await redis.keys(`${AUTH_PREFIX}:*`);
    const refreshKeys = await redis.keys(`${REFRESH_PREFIX}:*`);
    const claimKeys = await redis.keys(`${CLAIM_PREFIX}:*`);
    const all = [...authKeys, ...refreshKeys, ...claimKeys];
    if (all.length > 0) await redis.del(...all);
  });

  async function burnLimit(
    prefix: string,
    identity: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    for (let i = 0; i < limit; i += 1) {
      await consumeThrottle(redis, { keyPrefix: prefix, limit, windowSeconds }, identity);
    }
  }

  it('allows N Telegram auth attempts then RATE_LIMITED on N+1', async () => {
    const identity = 'ip-hash-auth-a';
    const limit = 3;
    await burnLimit(AUTH_PREFIX, identity, limit, 60);
    await expect(
      consumeThrottle(redis, { keyPrefix: AUTH_PREFIX, limit, windowSeconds: 60 }, identity),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('allows N refresh attempts then RATE_LIMITED on N+1', async () => {
    const identity = 'ip-hash-refresh-a';
    const limit = 2;
    await burnLimit(REFRESH_PREFIX, identity, limit, 60);
    await expect(
      consumeThrottle(redis, { keyPrefix: REFRESH_PREFIX, limit, windowSeconds: 60 }, identity),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('allows N Founder claim attempts then RATE_LIMITED on N+1', async () => {
    const identity = 'user-1:ip-hash-claim-a';
    const limit = 2;
    await burnLimit(CLAIM_PREFIX, identity, limit, 60);
    await expect(
      consumeThrottle(redis, { keyPrefix: CLAIM_PREFIX, limit, windowSeconds: 60 }, identity),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('resets the fixed window after expiry', async () => {
    const identity = 'ip-hash-window-reset';
    const limit = 1;
    const windowSeconds = 1;
    await consumeThrottle(redis, { keyPrefix: AUTH_PREFIX, limit, windowSeconds }, identity);
    await expect(
      consumeThrottle(redis, { keyPrefix: AUTH_PREFIX, limit, windowSeconds }, identity),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      consumeThrottle(redis, { keyPrefix: AUTH_PREFIX, limit, windowSeconds }, identity),
    ).resolves.toBeUndefined();
  });

  it('does not share Founder claim buckets across users or IPs', async () => {
    const limit = 1;
    await consumeThrottle(
      redis,
      { keyPrefix: CLAIM_PREFIX, limit, windowSeconds: 60 },
      'user-a:ip-1',
    );
    await expect(
      consumeThrottle(redis, { keyPrefix: CLAIM_PREFIX, limit, windowSeconds: 60 }, 'user-a:ip-1'),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(
      consumeThrottle(redis, { keyPrefix: CLAIM_PREFIX, limit, windowSeconds: 60 }, 'user-b:ip-1'),
    ).resolves.toBeUndefined();
    await expect(
      consumeThrottle(redis, { keyPrefix: CLAIM_PREFIX, limit, windowSeconds: 60 }, 'user-a:ip-2'),
    ).resolves.toBeUndefined();
  });

  it('fails closed when Redis is unavailable (does not fail open)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 200,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    try {
      await expect(
        consumeThrottle(dead, { keyPrefix: AUTH_PREFIX, limit: 100, windowSeconds: 60 }, 'any'),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    } finally {
      dead.disconnect();
    }
  });
});
