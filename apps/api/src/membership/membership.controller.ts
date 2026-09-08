import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  claimFounderCode,
  consumeThrottle,
  getMembershipView,
  hashIp,
  summarizeUserAgent,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';
import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { mapAuthError, requireString } from '../auth/http.js';

@Controller('v1/membership')
export class MembershipController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @UseGuards(AccessSessionGuard)
  async getMembership(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    try {
      return await getMembershipView(this.pool, auth.userId);
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Get('entitlements')
  @UseGuards(AccessSessionGuard)
  async getEntitlements(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    try {
      const view = await getMembershipView(this.pool, auth.userId);
      return { entitlements: view.entitlements, securityBypass: false };
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Post('founder/claim')
  @HttpCode(200)
  @UseGuards(AccessSessionGuard)
  async claimFounder(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const claimCode = requireString(body, 'claimCode');
    try {
      await consumeThrottle(
        this.redis,
        {
          keyPrefix: 'throttle:membership:claim',
          limit: this.config.CLAIM_RATE_LIMIT_MAX,
          windowSeconds: this.config.CLAIM_RATE_LIMIT_WINDOW_SECONDS,
        },
        `${auth.userId}:${hashIp(ip) ?? 'unknown'}`,
      );
      const result = await claimFounderCode(this.pool, {
        userId: auth.userId,
        rawClaimCode: claimCode,
        ipHash: hashIp(ip),
        userAgentSummary: summarizeUserAgent(userAgent),
      });
      return {
        membershipId: result.membershipId,
        planCode: result.planCode,
        founderNumber: result.founderNumber,
        status: result.status,
        claimedAt: result.claimedAt,
        moneyIssued: false,
        ledgerPostings: 0,
      };
    } catch (error) {
      throw mapAuthError(error);
    }
  }
}
