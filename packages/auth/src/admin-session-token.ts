import { sha256Hex, generateOpaqueToken } from './crypto.js';

/** Must stay identical to Recovery's hashPhase10CanaryOwnerSessionToken. */
export function hashAdminSessionToken(rawToken: string): string {
  return sha256Hex(`admin-session:${rawToken.trim()}`);
}

export function generateAdminSessionToken(): string {
  return generateOpaqueToken(32);
}

/** High-impact reauthentication window — aligned with Phase 10 Recovery. */
export const ADMIN_REAUTH_MAX_AGE_MS = 15 * 60 * 1000;

export const ADMIN_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
export const ADMIN_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
