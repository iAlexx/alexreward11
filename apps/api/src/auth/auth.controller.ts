import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  AuthDomainError,
  authenticateWithTelegramInitData,
  consumeThrottle,
  hashIp,
  listActiveSessions,
  redactSensitive,
  revokeAllUserSessions,
  revokeSession,
  rotateRefreshSession,
  summarizeUserAgent,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';
import {
  AccessSessionGuard,
  CurrentAuthUser,
  ParseUuidPipe,
  type AuthenticatedRequestUser,
} from './access-session.guard.js';
import { mapAuthError, requireString } from './http.js';

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  async telegram(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const initData = requireString(body, 'initData');
    try {
      await consumeThrottle(
        this.redis,
        {
          keyPrefix: 'throttle:auth:telegram',
          limit: this.config.AUTH_RATE_LIMIT_MAX,
          windowSeconds: this.config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        },
        hashIp(ip) ?? ip,
      );
      const result = await authenticateWithTelegramInitData(this.pool, {
        rawInitData: initData,
        botToken: this.config.TELEGRAM_BOT_TOKEN,
        maxAgeSeconds: this.config.INITDATA_MAX_AGE_SECONDS,
        session: {
          accessSecret: this.config.SESSION_ACCESS_SECRET,
          accessTtlSeconds: this.config.SESSION_ACCESS_TTL_SECONDS,
          refreshTtlSeconds: this.config.SESSION_REFRESH_TTL_SECONDS,
        },
        meta: { ip, userAgent: userAgent ?? null },
      });
      return {
        user: {
          id: result.user.id,
          telegramUserId: result.user.telegramUserId,
          username: result.user.username,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          preferredLocale: result.user.preferredLocale,
          status: result.user.status,
          withdrawalStatus: result.user.withdrawalStatus,
          created: result.user.created,
        },
        session: {
          accessToken: result.session.accessToken,
          accessExpiresAt: result.session.accessExpiresAt.toISOString(),
          refreshToken: result.session.refreshToken,
          refreshExpiresAt: result.session.refreshExpiresAt.toISOString(),
          sessionId: result.session.sessionId,
        },
      };
    } catch (error) {
      void redactSensitive({ route: 'telegram', ip });
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const refreshToken = requireString(body, 'refreshToken');
    try {
      await consumeThrottle(
        this.redis,
        {
          keyPrefix: 'throttle:auth:refresh',
          limit: this.config.AUTH_RATE_LIMIT_MAX,
          windowSeconds: this.config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        },
        hashIp(ip) ?? ip,
      );
      const session = await rotateRefreshSession(
        this.pool,
        {
          accessSecret: this.config.SESSION_ACCESS_SECRET,
          accessTtlSeconds: this.config.SESSION_ACCESS_TTL_SECONDS,
          refreshTtlSeconds: this.config.SESSION_REFRESH_TTL_SECONDS,
        },
        refreshToken,
        { ip, userAgent: userAgent ?? null },
      );
      return {
        accessToken: session.accessToken,
        accessExpiresAt: session.accessExpiresAt.toISOString(),
        refreshToken: session.refreshToken,
        refreshExpiresAt: session.refreshExpiresAt.toISOString(),
        sessionId: session.sessionId,
      };
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AccessSessionGuard)
  async logout(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    await revokeSession(this.pool, auth.sessionId, auth.userId, 'USER_LOGOUT');
  }

  @Post('revoke-all')
  @HttpCode(200)
  @UseGuards(AccessSessionGuard)
  async revokeAll(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    const count = await revokeAllUserSessions(this.pool, auth.userId, 'SECURITY_EVENT');
    return { revoked: count };
  }

  @Get('sessions')
  @UseGuards(AccessSessionGuard)
  async sessions(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    const sessions = await listActiveSessions(this.pool, auth.userId);
    return {
      sessions: sessions.map((item) => ({
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
        expiresAt: item.expiresAt.toISOString(),
        userAgentSummary: item.userAgentSummary,
        deviceSummary: item.deviceSummary,
        current: item.id === auth.sessionId,
      })),
    };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @UseGuards(AccessSessionGuard)
  async revokeOne(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await revokeSession(this.pool, id, auth.userId, 'USER_LOGOUT');
  }
}

export function requestUserAgent(userAgent: string | undefined): string | null {
  return summarizeUserAgent(userAgent);
}
