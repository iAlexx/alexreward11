import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  AuthDomainError,
  assertSessionActive,
  verifyAccessToken,
  type AccessTokenClaims,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import { API_CONFIG, DATABASE_POOL } from '../tokens.js';

export interface AuthenticatedRequestUser {
  readonly userId: string;
  readonly sessionId: string;
}

export type AuthedFastifyRequest = FastifyRequest & {
  authUser?: AuthenticatedRequestUser;
};

@Injectable()
export class AccessSessionGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedFastifyRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const claims: AccessTokenClaims = verifyAccessToken(token, this.config.SESSION_ACCESS_SECRET);
      await assertSessionActive(this.pool, claims.sid, claims.sub);
      request.authUser = { userId: claims.sub, sessionId: claims.sid };
      return true;
    } catch (error) {
      if (error instanceof AuthDomainError) {
        throw new UnauthorizedException({ error: error.code, message: error.publicMessage });
      }
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }
  }
}

export const CurrentAuthUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedRequestUser => {
    const request = context.switchToHttp().getRequest<AuthedFastifyRequest>();
    if (request.authUser === undefined) {
      throw new UnauthorizedException({
        error: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }
    return request.authUser;
  },
);

export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid identifier' });
    }
    return value;
  }
}
