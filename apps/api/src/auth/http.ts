import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthDomainError } from '@alex-rewards/auth';

export function requireString(body: unknown, field: string): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid request body' });
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException({ error: 'VALIDATION', message: `Missing ${field}` });
  }
  return value;
}

export function mapAuthError(error: unknown): HttpException {
  if (error instanceof AuthDomainError) {
    switch (error.code) {
      case 'RATE_LIMITED':
        return new HttpException(
          { error: error.code, message: error.publicMessage },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'UNAUTHENTICATED':
      case 'INVALID_TOKEN':
      case 'SESSION_REVOKED':
      case 'SESSION_EXPIRED':
      case 'REFRESH_REPLAY':
      case 'REFRESH_RACE':
        return new UnauthorizedException({
          error: error.code,
          message: error.publicMessage,
        });
      case 'FORBIDDEN':
        return new ForbiddenException({
          error: error.code,
          message: error.publicMessage,
        });
      case 'CLAIM_REJECTED':
      case 'VALIDATION':
        return new HttpException(
          { error: error.code, message: error.publicMessage },
          HttpStatus.BAD_REQUEST,
        );
      default:
        return new HttpException(
          { error: 'INTERNAL', message: 'Request failed' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
    }
  }
  return new HttpException(
    { error: 'INTERNAL', message: 'Request failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
