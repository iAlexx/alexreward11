import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthDomainError } from '@alex-rewards/auth';
import {
  isLocaleCode,
  isPublicPayoutIdentityMode,
  type LocaleCode,
  type PublicPayoutIdentityMode,
} from '@alex-rewards/contracts';
import { LedgerDomainError } from '@alex-rewards/ledger';

import { SettingsWriteError, type UserSettingsPatch } from './settings-write.js';

/**
 * Map a read-model failure onto HTTP.
 *
 * A missing or ambiguous payout asset is a deployment configuration fault, not a client
 * error, so it answers 503 rather than pretending the user has a zero balance.
 */
export function mapMeError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof SettingsWriteError) {
    const body = { error: error.code, message: error.message };
    switch (error.code) {
      case 'UNAUTHORIZED':
        return new UnauthorizedException(body);
      case 'VALIDATION':
        return new BadRequestException(body);
      case 'NOT_FOUND':
        return new NotFoundException(body);
      default:
        return new HttpException(body, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
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

/**
 * Parse PATCH /v1/me/settings.
 *
 * Accepts preferredLocale and/or publicPayoutIdentityMode. Security notifications are never
 * accepted as a writable field.
 */
export function parsePatchSettingsBody(body: unknown): UserSettingsPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid request body' });
  }
  const source = body as Record<string, unknown>;

  if ('securityNotificationsEnabled' in source) {
    throw new BadRequestException({
      error: 'VALIDATION',
      message: 'Security notifications cannot be disabled',
    });
  }

  const patch: {
    preferredLocale?: LocaleCode;
    publicPayoutIdentityMode?: PublicPayoutIdentityMode;
  } = {};

  if ('preferredLocale' in source) {
    const preferredLocale = source['preferredLocale'];
    if (!isLocaleCode(preferredLocale)) {
      throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid preferredLocale' });
    }
    patch.preferredLocale = preferredLocale;
  }

  if ('publicPayoutIdentityMode' in source) {
    const mode = source['publicPayoutIdentityMode'];
    if (!isPublicPayoutIdentityMode(mode)) {
      throw new BadRequestException({
        error: 'VALIDATION',
        message: 'Invalid publicPayoutIdentityMode',
      });
    }
    patch.publicPayoutIdentityMode = mode;
  }

  if (patch.preferredLocale === undefined && patch.publicPayoutIdentityMode === undefined) {
    throw new BadRequestException({
      error: 'VALIDATION',
      message: 'No settings fields to update',
    });
  }

  return patch;
}
