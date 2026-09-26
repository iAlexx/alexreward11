/**
 * HTTP-facing Owner Admin auth helpers for apps/api AdminAuthModule.
 * Independent of Telegram user AccessSession tokens.
 */
import type { Pool } from 'pg';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import { AuthDomainError } from './errors.js';
import {
  ADMIN_REAUTH_MAX_AGE_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  hashAdminSessionToken,
} from './admin-session-token.js';
import {
  isAdminSessionReauthFresh,
  loginOwnerAdmin,
  reauthenticateOwnerAdminSession,
  type LoginOwnerAdminBundle,
  type OwnerAdminAuthDatabaseGate,
  type ReauthOwnerAdminSessionResult,
} from './admin-auth.js';
import {
  consumeRecoveryCode,
  type ConsumeRecoveryCodeBundle,
} from './admin-recovery.js';
import {
  beginWebAuthnAuthentication,
  beginWebAuthnReauth,
  finishWebAuthnAuthentication,
  finishWebAuthnReauth,
  type AdminWebAuthnRpConfig,
  type BeginWebAuthnAuthenticationResult,
  type FinishWebAuthnAuthenticationBundle,
} from './admin-webauthn.js';

export interface VerifiedAdminSession {
  readonly adminUserId: string;
  readonly email: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly reauthenticatedAt: string | null;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly roles: readonly string[];
}

/**
 * Resolve an opaque admin session token to Owner identity + reauth freshness fields.
 * Does NOT accept Telegram user access tokens (different hash namespace / tables).
 */
export async function verifyAdminSessionToken(
  pool: Pool,
  token: string,
): Promise<VerifiedAdminSession> {
  const raw = token.trim();
  if (raw === '') {
    throw new AuthDomainError('UNAUTHENTICATED', 'admin session token required');
  }
  const tokenHash = hashAdminSessionToken(raw);
  const result = await pool.query<{
    session_id: string;
    admin_user_id: string;
    email: string;
    display_name: string;
    status: string;
    reauthenticated_at: Date | null;
    idle_expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT s.id::text AS session_id,
            s.admin_user_id::text,
            u.email,
            u.display_name,
            u.status::text,
            s.reauthenticated_at,
            s.idle_expires_at,
            s.absolute_expires_at,
            s.revoked_at
     FROM admin_sessions s
     INNER JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.session_token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'admin session not found');
  }
  if (row.revoked_at !== null) {
    throw new AuthDomainError('SESSION_REVOKED', 'admin session is revoked');
  }
  const now = Date.now();
  if (row.idle_expires_at.getTime() <= now || row.absolute_expires_at.getTime() <= now) {
    throw new AuthDomainError('SESSION_EXPIRED', 'admin session is expired');
  }
  if (row.status !== 'ACTIVE') {
    throw new AuthDomainError('FORBIDDEN', 'admin user is not ACTIVE');
  }

  const roles = await pool.query<{ code: string }>(
    `SELECT r.code::text
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [row.admin_user_id],
  );

  // Touch last_seen / idle extension without requiring a full TX for every read.
  const idle = new Date(now + ADMIN_SESSION_IDLE_TTL_MS);
  await pool.query(
    `UPDATE admin_sessions
     SET last_seen_at = now(),
         idle_expires_at = LEAST($2::timestamptz, absolute_expires_at)
     WHERE id = $1::uuid
       AND revoked_at IS NULL`,
    [row.session_id, idle.toISOString()],
  );

  return {
    adminUserId: row.admin_user_id,
    email: row.email,
    displayName: row.display_name,
    sessionId: row.session_id,
    reauthenticatedAt: row.reauthenticated_at?.toISOString() ?? null,
    idleExpiresAt: idle.toISOString(),
    absoluteExpiresAt: row.absolute_expires_at.toISOString(),
    roles: roles.rows.map((r) => r.code),
  };
}

/** V1: only OWNER role is authorized for Owner Admin Control Plane. */
export function assertAdminOwnerRole(session: VerifiedAdminSession): void {
  if (!session.roles.includes('OWNER')) {
    throw new AuthDomainError('FORBIDDEN', 'OWNER role required');
  }
}

export function assertRecentReauth(
  session: Pick<VerifiedAdminSession, 'reauthenticatedAt'>,
  maxAgeMs: number = ADMIN_REAUTH_MAX_AGE_MS,
  nowMs: number = Date.now(),
): void {
  if (!isAdminSessionReauthFresh(session.reauthenticatedAt, nowMs, maxAgeMs)) {
    throw new AuthDomainError('FORBIDDEN', 'recent reauthentication required');
  }
}

type GateFields = OwnerAdminAuthDatabaseGate;

/** Wrap existing password+TOTP login (both factors required). */
export async function loginViaPasswordTotp(
  pool: Pool,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly password: string;
    readonly totpCode: string;
    readonly evaluationTimeMs?: number;
    readonly expectedDatabase: string;
    readonly expectedClusterSystemIdentifier?: string | null;
    readonly operationalConfirm?: string | null;
  },
): Promise<LoginOwnerAdminBundle> {
  return loginOwnerAdmin(pool, {
    password: input.password,
    totpCode: input.totpCode,
    expectedDatabase: input.expectedDatabase,
    ...(input.adminUserId !== undefined ? { adminUserId: input.adminUserId } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.evaluationTimeMs !== undefined ? { evaluationTimeMs: input.evaluationTimeMs } : {}),
    ...(input.expectedClusterSystemIdentifier !== undefined
      ? { expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier }
      : {}),
    ...(input.operationalConfirm !== undefined
      ? { operationalConfirm: input.operationalConfirm }
      : {}),
  });
}

export async function loginViaWebAuthn(
  pool: Pool,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly response: AuthenticationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<FinishWebAuthnAuthenticationBundle> {
  return finishWebAuthnAuthentication(pool, input);
}

export async function beginLoginViaWebAuthn(
  pool: Pool,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnAuthenticationResult> {
  return beginWebAuthnAuthentication(pool, input);
}

/**
 * Recovery-code login policy (see consumeRecoveryCode): single-use, Owner-only,
 * creates a fresh admin session. Replay refuses.
 */
export async function loginViaRecoveryCode(
  pool: Pool,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly recoveryCode: string;
  } & GateFields,
): Promise<ConsumeRecoveryCodeBundle> {
  return consumeRecoveryCode(pool, input);
}

export async function reauthViaPasswordTotp(
  pool: Pool,
  input: {
    readonly sessionToken: string;
    readonly password: string;
    readonly totpCode: string;
    readonly evaluationTimeMs?: number;
    readonly expectedDatabase: string;
    readonly expectedClusterSystemIdentifier?: string | null;
    readonly operationalConfirm?: string | null;
  },
): Promise<ReauthOwnerAdminSessionResult> {
  return reauthenticateOwnerAdminSession(pool, {
    sessionToken: input.sessionToken,
    password: input.password,
    totpCode: input.totpCode,
    ...(input.evaluationTimeMs !== undefined ? { evaluationTimeMs: input.evaluationTimeMs } : {}),
    expectedDatabase: input.expectedDatabase,
    ...(input.expectedClusterSystemIdentifier !== undefined
      ? { expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier }
      : {}),
    ...(input.operationalConfirm !== undefined
      ? { operationalConfirm: input.operationalConfirm }
      : {}),
  });
}

export async function beginReauthViaWebAuthn(
  pool: Pool,
  input: {
    readonly adminUserId: string;
    readonly adminSessionId: string;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnAuthenticationResult> {
  return beginWebAuthnReauth(pool, input);
}

export async function reauthViaWebAuthn(
  pool: Pool,
  input: {
    readonly adminUserId: string;
    readonly sessionToken: string;
    readonly response: AuthenticationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<{ readonly adminUserId: string; readonly sessionId: string; readonly reauthenticatedAt: string }> {
  return finishWebAuthnReauth(pool, input);
}

/**
 * True when a bearer token looks like a Telegram user access JWT (not an admin opaque token).
 * Used by guards/tests to document isolation — admin verification never trusts user JWTs.
 */
export function looksLikeTelegramUserAccessToken(token: string): boolean {
  const parts = token.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}
