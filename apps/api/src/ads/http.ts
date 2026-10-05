import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AdsDomainError, type EnvironmentName } from '@alex-rewards/ads';
import type { ApiConfig } from '@alex-rewards/config';

/** Deployment environment names as the ad/reward domain spells them. */
export const ENVIRONMENT_BY_DEPLOYMENT: Readonly<
  Record<ApiConfig['DEPLOYMENT_ENV'], EnvironmentName>
> = {
  local: 'LOCAL',
  test: 'LOCAL',
  staging: 'STAGING',
  production: 'PRODUCTION',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Request fields the ad surface must never accept.
 *
 * The Reward Engine is the only module that prices a reward (Spec V1.3 §21). A client that
 * sends an amount is rejected outright rather than silently ignored, so a future refactor
 * cannot quietly start reading one.
 */
const FORBIDDEN_CLIENT_FIELDS: readonly string[] = [
  'amount',
  'amountAtomic',
  'baseAmountAtomic',
  'membershipBonusAmountAtomic',
  'quotedAmountAtomic',
  'rewardAmount',
  'rewardAmountAtomic',
  'bonusBps',
  'userShareBps',
  'ledgerTransactionId',
  'rewardEventId',
  'productionMonetaryStatus',
  'authenticity',
  'correlation',
  'verified',
];

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid request body' });
  }
  return body as Record<string, unknown>;
}

/** Reject any client attempt to assert money, authenticity or correlation. */
export function assertNoClientAuthorityFields(body: unknown): Record<string, unknown> {
  const source = asObject(body);
  for (const field of FORBIDDEN_CLIENT_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw new BadRequestException({
        error: 'VALIDATION',
        message: 'Client may not supply reward or verification authority fields',
      });
    }
  }
  return source;
}

export function requireUuid(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Missing ${field}` });
  }
  return value;
}

export function optionalUuid(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Invalid ${field}` });
  }
  return value;
}

export function requireProviderCode(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_CODE_PATTERN.test(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid providerCode' });
  }
  return value;
}

export function requireShortString(
  source: Record<string, unknown>,
  field: string,
  maxLength = 64,
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Missing ${field}` });
  }
  return value.trim();
}

export function optionalCountryCode(source: Record<string, unknown>): string | null {
  const value = source['countryCode'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid countryCode' });
  }
  return value;
}

/**
 * Forensic payload accepted from the mini app.
 *
 * Only primitive values survive; `packages/ads` redacts again before storage. Nothing here
 * is trusted for amounts, entitlements or limits.
 */
export function optionalSafePayload(
  source: Record<string, unknown>,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  const value = source['payload'];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid payload' });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 24) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid payload' });
  }
  const payload: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      payload[key] = item;
    } else if (typeof item === 'string') {
      payload[key] = item.slice(0, 256);
    }
  }
  return payload;
}

/**
 * Reward Engine refusals that are a normal "not available right now" for the ad surface.
 *
 * Matched structurally rather than by importing the Reward Engine: the ad HTTP surface has
 * no business depending on the module that posts money.
 */
const REWARD_ENGINE_CLIENT_REFUSALS: ReadonlySet<string> = new Set([
  'BUDGET_EXHAUSTED',
  'BUDGET_NOT_FOUND',
  'BUDGET_SCOPE_MISMATCH',
  'BONUS_BLOCKED',
  'BONUS_UNAVAILABLE',
  'GUARDRAIL_BLOCKED',
  'QUOTE_EXPIRED',
  'QUOTE_NOT_OPEN',
  'QUOTE_NOT_FOUND',
  'SOURCE_INVALID',
  'SOURCE_NOT_READY',
  'VALIDATION',
]);

function rewardEngineRefusalCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== 'RewardDomainError') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !REWARD_ENGINE_CLIENT_REFUSALS.has(code)) return null;
  return code;
}

/**
 * Map an ad-domain failure onto HTTP.
 *
 * A refusal to create money is a client-visible 4xx (the attempt is simply not rewardable),
 * never a 500 that would imply a platform fault. Internal detail is never echoed.
 */
export function mapAdsError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;

  const rewardRefusal = rewardEngineRefusalCode(error);
  if (rewardRefusal !== null) {
    return new BadRequestException({
      error: rewardRefusal,
      message: 'Rewarded ad is not available right now',
    });
  }

  if (error instanceof AdsDomainError) {
    const body = { error: error.code, message: error.publicMessage };
    switch (error.code) {
      case 'PROVIDER_NOT_FOUND':
      case 'SESSION_NOT_FOUND':
        return new NotFoundException(body);
      case 'SESSION_USER_MISMATCH':
        return new ForbiddenException(body);
      case 'PROVIDER_DISABLED':
      case 'PROVIDER_UNHEALTHY':
        return new ServiceUnavailableException(body);
      case 'SESSION_ALREADY_ACTIVE':
      case 'SESSION_TERMINAL':
      case 'SESSION_EXPIRED':
      case 'SESSION_STATE_INVALID':
        return new ConflictException(body);
      case 'RATE_LIMITED':
        return new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
      case 'VALIDATION':
      case 'PROVIDER_NOT_REGISTERED':
      case 'PROVIDER_MONETARY_BLOCKED':
      case 'LIMIT_RULE_MISSING':
      case 'LIMIT_RULE_AMBIGUOUS':
      case 'REQUEST_LIMIT_REACHED':
      case 'SUCCESS_LIMIT_REACHED':
      case 'SIGNAL_REJECTED':
      case 'SIGNAL_TYPE_UNKNOWN':
      case 'CORRELATION_AMBIGUOUS':
      case 'AUTHENTICITY_INSUFFICIENT':
      case 'QUOTE_MISSING':
      case 'REWARD_NOT_AUTHORIZED':
      case 'CLARIFICATION_GATE_OPEN':
      case 'WEBHOOK_PAYLOAD_INVALID':
        return new BadRequestException(body);
      case 'CERTIFICATION_CASE_UNSUPPORTED':
      case 'OWNER_DECISION_REQUIRED':
      case 'INTERNAL':
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
