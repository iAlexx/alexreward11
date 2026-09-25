import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  AuthDomainError,
  assertAdminOwnerRole,
  looksLikeTelegramUserAccessToken,
  verifyAdminSessionToken,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import type { Pool } from '@alex-rewards/db';

import { DATABASE_POOL } from '../tokens.js';

export const ADMIN_SESSION_COOKIE = 'admin_session';

export type AdminAuthedFastifyRequest = FastifyRequest & {
  adminSession?: VerifiedAdminSession;
  adminSessionToken?: string;
};

function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (header === undefined || header.trim() === '') return null;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Extract admin session token from Authorization Bearer or admin_session cookie. */
export function extractAdminSessionToken(request: FastifyRequest): {
  readonly token: string | null;
  readonly source: 'bearer' | 'cookie' | null;
} {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token !== '') return { token, source: 'bearer' };
  }
  const cookieHeader =
    typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
  const fromCookie = parseCookieHeader(cookieHeader, ADMIN_SESSION_COOKIE);
  if (fromCookie !== null && fromCookie !== '') {
    return { token: fromCookie, source: 'cookie' };
  }
  return { token: null, source: null };
}

/**
 * CSRF for cookie mode: require Origin (or Referer fallback) to match an allowed origin.
 * Bearer Authorization mode skips Origin enforcement (automation / tests).
 */
export function assertAdminCookieCsrf(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
  cookieMode: boolean,
): void {
  if (!cookieMode) return;
  if (allowedOrigins.length === 0) {
    throw new ForbiddenException({
      error: 'FORBIDDEN',
      message: 'cookie admin sessions require configured ADMIN_WEBAUTHN_ORIGIN / CORS origins',
    });
  }
  const originHeader = request.headers.origin;
  let origin =
    typeof originHeader === 'string' && originHeader.trim() !== ''
      ? originHeader.trim()
      : null;
  if (origin === null) {
    const referer = request.headers.referer;
    if (typeof referer === 'string' && referer.trim() !== '') {
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = null;
      }
    }
  }
  if (origin === null || !allowedOrigins.includes(origin)) {
    throw new ForbiddenException({
      error: 'FORBIDDEN',
      message: 'Origin check failed for cookie admin session',
    });
  }
}

/**
 * Admin session guard — independent of Telegram user AccessSessionGuard.
 * Telegram user JWTs must not authenticate here.
 */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthedFastifyRequest>();
    const extracted = extractAdminSessionToken(request);
    if (extracted.token === null) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Admin authentication required',
      });
    }
    if (looksLikeTelegramUserAccessToken(extracted.token)) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Telegram user session cannot authenticate Owner Admin',
      });
    }
    if (extracted.source === 'cookie') {
      // Cookie CSRF is enforced in the controller helpers with config origins.
      // Guard still rejects missing tokens; controllers call assertAdminCookieCsrf.
    }
    try {
      const session = await verifyAdminSessionToken(this.pool, extracted.token);
      assertAdminOwnerRole(session);
      request.adminSession = session;
      request.adminSessionToken = extracted.token;
      return true;
    } catch (error) {
      if (error instanceof AuthDomainError) {
        if (error.code === 'FORBIDDEN') {
          throw new ForbiddenException({ error: error.code, message: error.publicMessage });
        }
        throw new UnauthorizedException({ error: error.code, message: error.publicMessage });
      }
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Admin authentication required',
      });
    }
  }
}

export const CurrentAdminSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedAdminSession => {
    const request = context.switchToHttp().getRequest<AdminAuthedFastifyRequest>();
    if (request.adminSession === undefined) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Admin authentication required',
      });
    }
    return request.adminSession;
  },
);

export const CurrentAdminSessionToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AdminAuthedFastifyRequest>();
    if (request.adminSessionToken === undefined || request.adminSessionToken === '') {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Admin authentication required',
      });
    }
    return request.adminSessionToken;
  },
);
