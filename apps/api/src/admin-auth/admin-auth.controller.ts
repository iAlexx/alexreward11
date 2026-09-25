import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';

import {
  AuthDomainError,
  beginLoginViaWebAuthn,
  beginReauthViaWebAuthn,
  beginWebAuthnRegistration,
  consumeThrottle,
  finishWebAuthnRegistration,
  hashIp,
  loginViaPasswordTotp,
  loginViaRecoveryCode,
  loginViaWebAuthn,
  logoutOwnerAdminSession,
  reauthViaPasswordTotp,
  reauthViaWebAuthn,
  resolveAdminWebAuthnRpConfig,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import { mapAuthError, requireString } from '../auth/http.js';
import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';
import {
  AdminSessionGuard,
  CurrentAdminSession,
  CurrentAdminSessionToken,
  extractAdminSessionToken,
  type AdminAuthedFastifyRequest,
} from './admin-session.guard.js';
import {
  clearAdminSessionCookie,
  databaseNameFromUrl,
  enforceAdminCsrfIfCookie,
  optionalString,
  setAdminSessionCookie,
} from './http.js';

@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private rp() {
    return resolveAdminWebAuthnRpConfig({
      deploymentEnv: this.config.DEPLOYMENT_ENV,
      rpId: this.config.ADMIN_WEBAUTHN_RP_ID,
      rpName: this.config.ADMIN_WEBAUTHN_RP_NAME,
      origin: this.config.ADMIN_WEBAUTHN_ORIGIN,
    });
  }

  private gate() {
    return { expectedDatabase: databaseNameFromUrl(this.config.DATABASE_URL) };
  }

  private async throttle(ip: string, route: string): Promise<void> {
    await consumeThrottle(
      this.redis,
      {
        keyPrefix: `throttle:admin-auth:${route}`,
        limit: this.config.AUTH_RATE_LIMIT_MAX,
        windowSeconds: this.config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      },
      hashIp(ip) ?? ip,
    );
  }

  @Post('webauthn/register/options')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  async webauthnRegisterOptions(
    @Req() request: AdminAuthedFastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Ip() ip: string,
  ) {
    try {
      enforceAdminCsrfIfCookie(request, this.config);
      await this.throttle(ip, 'webauthn-register-options');
      const begun = await beginWebAuthnRegistration(this.pool, {
        adminUserId: session.adminUserId,
        rp: this.rp(),
        ...this.gate(),
      });
      return {
        options: begun.options,
        challengeId: begun.challengeId,
        expiresAt: begun.expiresAt,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('webauthn/register/verify')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  async webauthnRegisterVerify(
    @Req() request: AdminAuthedFastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    try {
      enforceAdminCsrfIfCookie(request, this.config);
      await this.throttle(ip, 'webauthn-register-verify');
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AuthDomainError('VALIDATION', 'Invalid request body');
      }
      const response = (body as Record<string, unknown>).response;
      if (response === null || typeof response !== 'object') {
        throw new AuthDomainError('VALIDATION', 'Missing response');
      }
      const result = await finishWebAuthnRegistration(this.pool, {
        adminUserId: session.adminUserId,
        // RegistrationResponseJSON shape from browser
        response: response as never,
        rp: this.rp(),
        label: optionalString(body, 'label'),
        ...this.gate(),
      });
      return {
        adminUserId: result.adminUserId,
        credentialRowId: result.credentialRowId,
        credentialId: result.credentialId,
        signCount: result.signCount,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('webauthn/login/options')
  @HttpCode(200)
  async webauthnLoginOptions(@Body() body: unknown, @Ip() ip: string) {
    try {
      await this.throttle(ip, 'webauthn-login-options');
      const begun = await beginLoginViaWebAuthn(this.pool, {
        adminUserId: optionalString(body, 'adminUserId'),
        email: optionalString(body, 'email'),
        rp: this.rp(),
        ...this.gate(),
      });
      return {
        adminUserId: begun.adminUserId,
        options: begun.options,
        challengeId: begun.challengeId,
        expiresAt: begun.expiresAt,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('webauthn/login/verify')
  @HttpCode(200)
  async webauthnLoginVerify(
    @Body() body: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      await this.throttle(ip, 'webauthn-login-verify');
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AuthDomainError('VALIDATION', 'Invalid request body');
      }
      const response = (body as Record<string, unknown>).response;
      if (response === null || typeof response !== 'object') {
        throw new AuthDomainError('VALIDATION', 'Missing response');
      }
      const bundle = await loginViaWebAuthn(this.pool, {
        adminUserId: optionalString(body, 'adminUserId'),
        email: optionalString(body, 'email'),
        response: response as never,
        rp: this.rp(),
        ...this.gate(),
      });
      const sessionToken = bundle.takeSessionTokenOnce();
      setAdminSessionCookie(reply, sessionToken, this.config);
      return {
        adminUserId: bundle.result.adminUserId,
        email: bundle.result.email,
        sessionId: bundle.result.sessionId,
        idleExpiresAt: bundle.result.idleExpiresAt,
        absoluteExpiresAt: bundle.result.absoluteExpiresAt,
        reauthenticatedAt: bundle.result.reauthenticatedAt,
        sessionToken,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('login/password-totp')
  @HttpCode(200)
  async loginPasswordTotp(
    @Body() body: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      await this.throttle(ip, 'login-password-totp');
      const password = requireString(body, 'password');
      const totpCode = requireString(body, 'totpCode');
      const bundle = await loginViaPasswordTotp(this.pool, {
        adminUserId: optionalString(body, 'adminUserId'),
        email: optionalString(body, 'email'),
        password,
        totpCode,
        ...this.gate(),
      });
      const sessionToken = bundle.takeSessionTokenOnce();
      setAdminSessionCookie(reply, sessionToken, this.config);
      return {
        adminUserId: bundle.result.adminUserId,
        email: bundle.result.email,
        sessionId: bundle.result.sessionId,
        idleExpiresAt: bundle.result.idleExpiresAt,
        absoluteExpiresAt: bundle.result.absoluteExpiresAt,
        reauthenticatedAt: bundle.result.reauthenticatedAt,
        sessionToken,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('recovery/consume')
  @HttpCode(200)
  async recoveryConsume(
    @Body() body: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      await this.throttle(ip, 'recovery-consume');
      const recoveryCode = requireString(body, 'recoveryCode');
      const bundle = await loginViaRecoveryCode(this.pool, {
        adminUserId: optionalString(body, 'adminUserId'),
        email: optionalString(body, 'email'),
        recoveryCode,
        ...this.gate(),
      });
      const sessionToken = bundle.takeSessionTokenOnce();
      setAdminSessionCookie(reply, sessionToken, this.config);
      return {
        adminUserId: bundle.result.adminUserId,
        email: bundle.result.email,
        sessionId: bundle.result.sessionId,
        idleExpiresAt: bundle.result.idleExpiresAt,
        absoluteExpiresAt: bundle.result.absoluteExpiresAt,
        reauthenticatedAt: bundle.result.reauthenticatedAt,
        sessionToken,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('reauth/password-totp')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  async reauthPasswordTotp(
    @Req() request: AdminAuthedFastifyRequest,
    @CurrentAdminSessionToken() sessionToken: string,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    try {
      enforceAdminCsrfIfCookie(request, this.config);
      await this.throttle(ip, 'reauth-password-totp');
      const password = requireString(body, 'password');
      const totpCode = requireString(body, 'totpCode');
      const result = await reauthViaPasswordTotp(this.pool, {
        sessionToken,
        password,
        totpCode,
        ...this.gate(),
      });
      return {
        adminUserId: result.adminUserId,
        sessionId: result.sessionId,
        reauthenticatedAt: result.reauthenticatedAt,
        reauthMaxAgeMs: result.reauthMaxAgeMs,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('reauth/webauthn')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  async reauthWebAuthn(
    @Req() request: AdminAuthedFastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @CurrentAdminSessionToken() sessionToken: string,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('x-admin-webauthn-phase') phaseHeader: string | undefined,
  ) {
    try {
      enforceAdminCsrfIfCookie(request, this.config);
      await this.throttle(ip, 'reauth-webauthn');
      const phase =
        typeof phaseHeader === 'string' && phaseHeader.trim() !== ''
          ? phaseHeader.trim().toLowerCase()
          : optionalString(body, 'phase')?.toLowerCase() ?? 'verify';

      if (phase === 'options') {
        const begun = await beginReauthViaWebAuthn(this.pool, {
          adminUserId: session.adminUserId,
          rp: this.rp(),
          ...this.gate(),
        });
        return {
          phase: 'options',
          options: begun.options,
          challengeId: begun.challengeId,
          expiresAt: begun.expiresAt,
        };
      }

      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AuthDomainError('VALIDATION', 'Invalid request body');
      }
      const response = (body as Record<string, unknown>).response;
      if (response === null || typeof response !== 'object') {
        throw new AuthDomainError('VALIDATION', 'Missing response');
      }
      const result = await reauthViaWebAuthn(this.pool, {
        adminUserId: session.adminUserId,
        sessionToken,
        response: response as never,
        rp: this.rp(),
        ...this.gate(),
      });
      return {
        phase: 'verify',
        adminUserId: result.adminUserId,
        sessionId: result.sessionId,
        reauthenticatedAt: result.reauthenticatedAt,
      };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  async logout(
    @Req() request: AdminAuthedFastifyRequest,
    @CurrentAdminSessionToken() sessionToken: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      enforceAdminCsrfIfCookie(request, this.config);
      await this.throttle(ip, 'logout');
      const result = await logoutOwnerAdminSession(this.pool, {
        sessionToken,
        ...this.gate(),
      });
      clearAdminSessionCookie(reply, this.config);
      return { sessionId: result.sessionId, revoked: result.revoked };
    } catch (error) {
      if (error instanceof AuthDomainError) throw mapAuthError(error);
      throw mapAuthError(error);
    }
  }

  @Get('session')
  @UseGuards(AdminSessionGuard)
  async session(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
  ) {
    enforceAdminCsrfIfCookie(request, this.config);
    const extracted = extractAdminSessionToken(request);
    return {
      adminUserId: session.adminUserId,
      email: session.email,
      displayName: session.displayName,
      sessionId: session.sessionId,
      reauthenticatedAt: session.reauthenticatedAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      roles: session.roles,
      authSource: extracted.source,
    };
  }
}
