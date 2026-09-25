import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthDomainError } from '@alex-rewards/auth';
import { isLocaleCode, type LocaleCode } from '@alex-rewards/contracts';
import { LedgerDomainError } from '@alex-rewards/ledger';

/**
 * Map a read-model failure onto HTTP.
 *
 * A missing or ambiguous payout asset is a deployment configuration fault, not a client
 * error, so it answers 503 rather than pretending the user has a zero balance.
 */
export function mapMeError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AuthDomainError) {
    if (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN') {
      return new UnauthorizedException({ error: error.code, message: error.publicMessage });
    }
  }
  if (error instanceof LedgerDomainError && error.code === 'VALIDATION') {
    return new ServiceUnavailableException({
      error: 'NOT_CONFIGURED',
      message: 'Balances are temporarily unavailable',
    });
  }
  return new HttpException(
    { error: 'INTERNAL', message: 'Request failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** Parse the only setting this phase lets a user change. */
export function parsePatchSettingsBody(body: unknown): { readonly preferredLocale: LocaleCode } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid request body' });
  }
  const preferredLocale = (body as Record<string, unknown>)['preferredLocale'];
  if (!isLocaleCode(preferredLocale)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid preferredLocale' });
  }
  return { preferredLocale };
}
