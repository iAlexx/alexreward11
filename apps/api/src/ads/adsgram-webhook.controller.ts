import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  ADSGRAM_REWARD_URL_PATH,
  ingestAdsGramRewardUrl,
  type WebhookRateLimitDecision,
} from '@alex-rewards/ads';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';

import { mapAdsError } from './http.js';

/** `/webhooks/adsgram` + `reward` must keep matching the configured provider Reward URL. */
const WEBHOOK_BASE_PATH = ADSGRAM_REWARD_URL_PATH.replace(/^\/+/, '').replace(/\/reward$/, '');

/**
 * AdsGram Reward URL receiver.
 *
 * This endpoint is unauthenticated because the provider calls it server-to-server with no
 * user session, and — for this integration — with no signature either. That is exactly why
 * it has no financial authority: it stores a normalized, redacted provider event, tries to
 * correlate it to at most one live session, and appends UNVERIFIED evidence. It never
 * updates a balance, never posts a ledger transaction and never issues a reward.
 *
 * The response is intentionally uniform and content-free so the endpoint cannot be used as
 * an oracle for which Telegram user ids or sessions exist.
 */
@Controller(WEBHOOK_BASE_PATH)
export class AdsGramWebhookController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('reward')
  async reward(@Query() query: Record<string, unknown>) {
    try {
      await ingestAdsGramRewardUrl(this.pool, {
        query,
        rateLimitHook: (input) => this.consumeRateLimit(input.key),
      });
    } catch (error) {
      throw mapAdsError(error);
    }
    // Always the same body. Ingestion outcome is observable to operators, not to callers.
    return { accepted: true, rewardCredited: false };
  }

  /**
   * Abuse protection for an unauthenticated provider endpoint.
   *
   * Phase 11 stub: it reuses the approved generic edge-rate-limit configuration. A
   * dedicated provider-webhook limit (and whether unattributed calls share one bucket) is
   * OWNER_DECISION_REQUIRED and is not invented here. The limiter is a defence against
   * abuse — it is never the control that stops money, because this path cannot create any.
   */
  private async consumeRateLimit(key: string): Promise<WebhookRateLimitDecision> {
    const windowSeconds = this.config.AUTH_RATE_LIMIT_WINDOW_SECONDS;
    const redisKey = `throttle:webhook:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.expire(redisKey, windowSeconds);
      }
      if (count > this.config.AUTH_RATE_LIMIT_MAX) {
        return { allowed: false, retryAfterSeconds: windowSeconds };
      }
      return { allowed: true };
    } catch {
      // Fail closed: an unavailable limiter must not become an open unauthenticated door.
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }
  }
}
