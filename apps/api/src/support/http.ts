import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { SupportDomainError, publicSupportFailureMessage } from '@alex-rewards/support';

export function mapSupportError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof SupportDomainError) {
    const body = { error: error.code, message: publicSupportFailureMessage(error.code) };
    switch (error.code) {
      case 'UNAUTHORIZED':
        return new UnauthorizedException(body);
      case 'VALIDATION':
        return new BadRequestException(body);
      case 'NOT_FOUND':
      case 'FORBIDDEN':
        return new NotFoundException(body);
      case 'CONFLICT':
        return new ConflictException(body);
      default:
        return new HttpException(body, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  return new HttpException(
    { error: 'INTERNAL', message: 'Request failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid request body' });
  }
  return body as Record<string, unknown>;
}
