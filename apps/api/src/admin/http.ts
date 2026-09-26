/**
 * Shared Admin HTTP helpers — CSRF, high-impact gates, envelope helpers.
 */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  AuthDomainError,
  assertRecentReauth,
  consumeAdminWebConfirmation,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';
import { AdsDomainError } from '@alex-rewards/ads';
import { ControlCenterError } from '@alex-rewards/control-center';
import { RewardDomainError } from '@alex-rewards/rewards';
import { WithdrawalDomainError } from '@alex-rewards/withdrawals';

import {
  assertAdminCookieCsrf,
  extractAdminSessionToken,
} from '../admin-auth/admin-session.guard.js';
import { adminAllowedOrigins } from '../admin-auth/http.js';

export function enforceAdminMutationCsrf(
  request: FastifyRequest,
  config: ApiConfig,
): void {
  const extracted = extractAdminSessionToken(request);
  assertAdminCookieCsrf(
    request,
    adminAllowedOrigins(config),
    extracted.source === 'cookie',
  );
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException({ error: 'VALIDATION', message: `${field} is required` });
  }
  return value.trim();
}

export function requireReason(body: { readonly reason?: unknown }): string {
  return requireNonEmptyString(body.reason, 'reason');
}

export function requireExpectedVersion(body: { readonly expectedVersion?: unknown }): string {
  return requireNonEmptyString(body.expectedVersion, 'expectedVersion');
}

/** High-impact mutations require recent reauth + reason + expectedVersion. */
export function gateHighImpactMutation(
  session: VerifiedAdminSession,
  body: { readonly reason?: unknown; readonly expectedVersion?: unknown },
): { readonly reason: string; readonly expectedVersion: string } {
  try {
    assertRecentReauth(session);
  } catch (error) {
    if (error instanceof AuthDomainError) {
      throw new ForbiddenException({ error: error.code, message: error.publicMessage });
    }
    throw error;
  }
  return {
    reason: requireReason(body),
    expectedVersion: requireExpectedVersion(body),
  };
}

/**
 * Mandatory one-time consume of a server-issued confirmationId.
 * Client HighImpactConfirmationBinding must never authorize.
 */
export async function requireConsumedConfirmation(
  pool: Pool,
  session: VerifiedAdminSession,
  confirmationId: unknown,
  attempt: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly expectedVersion: string;
    readonly payload: unknown;
  },
): Promise<void> {
  if (typeof confirmationId !== 'string' || confirmationId.trim() === '') {
    throw new ForbiddenException({
      error: 'CONFIRMATION_REQUIRED',
      message: 'server confirmationId is required for high-impact mutations',
    });
  }
  try {
    await consumeAdminWebConfirmation(pool, {
      session,
      confirmationId: confirmationId.trim(),
      actionType: attempt.action,
      resourceType: attempt.resourceType,
      resourceId: attempt.resourceId,
      expectedVersion: attempt.expectedVersion,
      payload: attempt.payload,
    });
  } catch (error) {
    if (error instanceof AuthDomainError) {
      throw new ForbiddenException({
        error: 'CONFIRMATION_INVALID',
        message: error.publicMessage,
        code: error.code,
      });
    }
    throw error;
  }
}

export function mapAdminDomainError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AuthDomainError) {
    if (error.code === 'FORBIDDEN') {
      throw new ForbiddenException({ error: error.code, message: error.publicMessage });
    }
    if (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED') {
      throw new UnauthorizedException({ error: error.code, message: error.publicMessage });
    }
    throw new BadRequestException({ error: error.code, message: error.publicMessage });
  }
  if (error instanceof AdsDomainError) {
    throw new BadRequestException({
      error: error.code,
      message: error.publicMessage,
      details: error.details,
    });
  }
  if (error instanceof WithdrawalDomainError) {
    throw new BadRequestException({
      error: error.code,
      message: error.publicMessage,
      details: error.details,
    });
  }
  if (error instanceof RewardDomainError) {
    throw new BadRequestException({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof ControlCenterError) {
    throw new BadRequestException({
      error: error.code,
      message: error.message,
      details: error.details,
    });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const code = (error as { code: string }).code;
    const message = error instanceof Error ? error.message : code;
    if (code === 'FORBIDDEN') {
      throw new ForbiddenException({ error: code, message });
    }
    throw new BadRequestException({ error: code, message });
  }
  throw error;
}

/** Refuse arbitrary code / eval / SQL execution payloads in Policy Center. */
export function refuseArbitraryPolicyPayload(body: Record<string, unknown>): void {
  const forbiddenKeys = [
    'expression',
    'script',
    'sql',
    'eval',
    'javascript',
    'js',
    'code',
    'query',
    'rawSql',
    'raw_sql',
  ] as const;
  for (const key of forbiddenKeys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      throw new BadRequestException({
        error: 'POLICY_ARBITRARY_CODE_REFUSED',
        message: 'Policy Center accepts typed rule families only; arbitrary code/SQL/eval is refused',
        field: key,
      });
    }
  }
}

export const PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE =
  'Phase 10 baseline: PAYOUT_DISPATCH_PAUSE remained enabled. Display is allowed; ' +
  'silent flip of accepted state is refused. Owner may change only with explicit reason + recent reauth + expectedVersion ceremony. Do not auto-change.';

export const FORBIDDEN_BALANCE_EDITOR_PATHS = [
  'set-balance',
  'setBalance',
  'adjust-balance',
  'direct-balance',
  'balance-editor',
] as const;
