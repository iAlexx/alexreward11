import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '@alex-rewards/config';

import {
  ADMIN_SESSION_COOKIE,
  assertAdminCookieCsrf,
  extractAdminSessionToken,
} from './admin-session.guard.js';

export function adminAllowedOrigins(config: ApiConfig): readonly string[] {
  const origins = new Set<string>();
  for (const origin of config.CORS_ORIGINS) {
    if (origin.trim() !== '') origins.add(origin.trim());
  }
  if (config.ADMIN_WEBAUTHN_ORIGIN.trim() !== '') {
    origins.add(config.ADMIN_WEBAUTHN_ORIGIN.trim());
  }
  return [...origins];
}

export function enforceAdminCsrfIfCookie(request: FastifyRequest, config: ApiConfig): void {
  const extracted = extractAdminSessionToken(request);
  assertAdminCookieCsrf(request, adminAllowedOrigins(config), extracted.source === 'cookie');
}

export function databaseNameFromUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

export function setAdminSessionCookie(
  reply: FastifyReply,
  token: string,
  config: ApiConfig,
): void {
  const secure = config.DEPLOYMENT_ENV !== 'local' && config.DEPLOYMENT_ENV !== 'test';
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/v1/admin',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearAdminSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  const secure = config.DEPLOYMENT_ENV !== 'local' && config.DEPLOYMENT_ENV !== 'test';
  const parts = [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/v1/admin',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function optionalString(body: unknown, field: string): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
