/**
 * Owner Admin recovery codes — cryptographic one-time codes, hashed at rest.
 * Plaintext codes are shown once and must never be logged.
 */
import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from './errors.js';
import { sha256Hex } from './crypto.js';
import {
  OWNER_ADMIN_AUTH_FAILURE_WINDOW_MS,
  OWNER_ADMIN_AUTH_LOCKOUT_MS,
  OWNER_ADMIN_AUTH_MAX_FAILURES,
  assertOwnerAdminAuthDatabaseWritable,
  requireOwnerAuthPool,
  withPoolOwnedOwnerAuthTransaction,
  type OwnerAdminAuthDatabaseGate,
} from './admin-auth.js';
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  generateAdminSessionToken,
  hashAdminSessionToken,
} from './admin-session-token.js';

type Db = Pool | PoolClient;
type GateFields = OwnerAdminAuthDatabaseGate;

export const ADMIN_RECOVERY_CODE_COUNT = 10;
export const ADMIN_RECOVERY_CODE_BYTE_LENGTH = 10;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashAdminRecoveryCode(rawCode: string): string {
  const normalized = normalizeRecoveryCode(rawCode);
  return sha256Hex(`admin-recovery:${normalized}`);
}

export function normalizeRecoveryCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Format groups of 4 for display (never log). */
export function formatRecoveryCodeForDisplay(normalized: string): string {
  const clean = normalizeRecoveryCode(normalized);
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    parts.push(clean.slice(i, i + 4));
  }
  return parts.join('-');
}

function generateOneRecoveryCode(): string {
  const bytes = randomBytes(ADMIN_RECOVERY_CODE_BYTE_LENGTH);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length] ?? 'A';
  }
  return formatRecoveryCodeForDisplay(out);
}

async function requireActiveOwner(
  client: PoolClient,
  adminUserId: string,
  options?: { readonly forUpdate?: boolean },
): Promise<{ id: string; email: string }> {
  const lock = options?.forUpdate === true ? ' FOR UPDATE' : '';
  const admin = await client.query<{
    id: string;
    email: string;
    status: string;
  }>(
    `SELECT id::text, email, status::text FROM admin_users WHERE id = $1::uuid${lock}`,
    [adminUserId],
  );
  const row = admin.rows[0];
  if (row === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'admin user not found');
  }
  if (row.status !== 'ACTIVE') {
    throw new AuthDomainError('FORBIDDEN', 'admin user is not ACTIVE');
  }
  const binding = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [adminUserId],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) {
    throw new AuthDomainError('FORBIDDEN', 'admin lacks ACTIVE unrevoked OWNER role binding');
  }
  return { id: row.id, email: row.email };
}

async function resolveAdminUserId(
  client: PoolClient,
  input: { adminUserId?: string | null; email?: string | null },
): Promise<string> {
  if (input.adminUserId !== undefined && input.adminUserId !== null && input.adminUserId.trim() !== '') {
    return input.adminUserId.trim();
  }
  const email = input.email?.trim().toLowerCase();
  if (email === undefined || email === '') {
    throw new AuthDomainError('VALIDATION', 'adminUserId or email is required');
  }
  const found = await client.query<{ id: string }>(
    `SELECT id::text FROM admin_users WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  const id = found.rows[0]?.id;
  if (id === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'admin user not found');
  }
  return id;
}

async function insertRedactedAudit(
  client: PoolClient,
  input: {
    readonly adminUserId: string | null;
    readonly actionType: string;
    readonly resourceType: string;
    readonly resourceId: string | null;
    readonly reason: string;
    readonly afterSnapshot?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (
       admin_user_id, actor_type, action_type, resource_type, resource_id,
       after_snapshot, reason, source
     ) VALUES (
       $1::uuid, 'ADMIN', $2, $3, $4::uuid, $5::jsonb, $6, 'API'
     )`,
    [
      input.adminUserId,
      input.actionType,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.afterSnapshot ?? {}),
      input.reason,
    ],
  );
}

async function ensureThrottleRow(client: PoolClient, adminUserId: string): Promise<void> {
  await client.query(
    `INSERT INTO admin_auth_throttle (admin_user_id)
     VALUES ($1::uuid)
     ON CONFLICT (admin_user_id) DO NOTHING`,
    [adminUserId],
  );
}

async function lockThrottleForUpdate(client: PoolClient, adminUserId: string): Promise<void> {
  await ensureThrottleRow(client, adminUserId);
  await client.query(
    `SELECT admin_user_id FROM admin_auth_throttle WHERE admin_user_id = $1::uuid FOR UPDATE`,
    [adminUserId],
  );
}

async function assertNotLocked(client: PoolClient, adminUserId: string): Promise<void> {
  const row = await client.query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
    [adminUserId],
  );
  const lockedUntil = row.rows[0]?.locked_until;
  if (lockedUntil !== null && lockedUntil !== undefined && lockedUntil.getTime() > Date.now()) {
    throw new AuthDomainError('RATE_LIMITED', 'authentication temporarily locked', {
      details: { lockedUntil: lockedUntil.toISOString() },
    });
  }
}

async function recordAuthFailure(client: PoolClient, adminUserId: string): Promise<void> {
  await ensureThrottleRow(client, adminUserId);
  const current = await client.query<{
    failed_attempts: number;
    window_started_at: Date;
  }>(
    `SELECT failed_attempts, window_started_at
     FROM admin_auth_throttle WHERE admin_user_id = $1::uuid FOR UPDATE`,
    [adminUserId],
  );
  const row = current.rows[0];
  if (row === undefined) return;
  const now = Date.now();
  let failed = row.failed_attempts;
  let windowStart = row.window_started_at.getTime();
  if (now - windowStart > OWNER_ADMIN_AUTH_FAILURE_WINDOW_MS) {
    failed = 0;
    windowStart = now;
  }
  failed += 1;
  const lockedUntil =
    failed >= OWNER_ADMIN_AUTH_MAX_FAILURES
      ? new Date(now + OWNER_ADMIN_AUTH_LOCKOUT_MS)
      : null;
  await client.query(
    `UPDATE admin_auth_throttle
     SET failed_attempts = $2,
         window_started_at = $3::timestamptz,
         locked_until = $4::timestamptz,
         updated_at = now()
     WHERE admin_user_id = $1::uuid`,
    [adminUserId, failed, new Date(windowStart).toISOString(), lockedUntil?.toISOString() ?? null],
  );
  await insertRedactedAudit(client, {
    adminUserId,
    actionType: 'owner_admin_auth.failure',
    resourceType: 'admin_user',
    resourceId: adminUserId,
    reason: lockedUntil
      ? 'authentication failure — lockout engaged'
      : 'recovery code authentication failure',
    afterSnapshot: { failedAttempts: failed, locked: lockedUntil !== null, factor: 'RECOVERY' },
  });
}

async function clearAuthFailures(client: PoolClient, adminUserId: string): Promise<void> {
  await client.query(
    `UPDATE admin_auth_throttle
     SET failed_attempts = 0,
         window_started_at = now(),
         locked_until = NULL,
         updated_at = now()
     WHERE admin_user_id = $1::uuid`,
    [adminUserId],
  );
}

export interface GenerateRecoveryCodesResult {
  readonly adminUserId: string;
  readonly codeCount: number;
  /**
   * Plaintext codes shown once. Caller must display securely and never log.
   * Access via takePlaintextCodesOnce().
   */
  takePlaintextCodesOnce(): readonly string[];
}

function createRecoveryCodeBundle(
  adminUserId: string,
  codes: readonly string[],
): GenerateRecoveryCodesResult {
  let remaining: readonly string[] | null = codes;
  return {
    adminUserId,
    codeCount: codes.length,
    takePlaintextCodesOnce(): readonly string[] {
      if (remaining === null) {
        throw new Error('recovery codes already consumed from bundle');
      }
      const out = remaining;
      remaining = null;
      return out;
    },
  };
}

async function insertRecoveryCodeHashes(
  client: PoolClient,
  adminUserId: string,
  plaintextCodes: readonly string[],
): Promise<void> {
  for (const code of plaintextCodes) {
    const hash = hashAdminRecoveryCode(code);
    await client.query(
      `INSERT INTO admin_recovery_codes (admin_user_id, code_verifier_hash)
       VALUES ($1::uuid, $2)`,
      [adminUserId, hash],
    );
  }
}

/**
 * Generate a fresh set of recovery codes. Does not revoke prior unused codes —
 * use rotateRecoveryCodes for rotation. Plaintext never logged.
 */
export async function generateRecoveryCodes(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly count?: number;
  } & GateFields,
): Promise<GenerateRecoveryCodesResult> {
  const pool = requireOwnerAuthPool(db);
  const count = input.count ?? ADMIN_RECOVERY_CODE_COUNT;
  if (count < 1 || count > 32) {
    throw new AuthDomainError('VALIDATION', 'recovery code count must be between 1 and 32');
  }

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = generateOneRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    codes.push(code);
  }

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    await requireActiveOwner(client, input.adminUserId, { forUpdate: true });
    await insertRecoveryCodeHashes(client, input.adminUserId, codes);
    await insertRedactedAudit(client, {
      adminUserId: input.adminUserId,
      actionType: 'owner_admin_auth.recovery_codes_generated',
      resourceType: 'admin_user',
      resourceId: input.adminUserId,
      reason: 'Owner recovery codes generated',
      afterSnapshot: { codeCount: codes.length },
    });
    return { status: 'ok' as const, value: createRecoveryCodeBundle(input.adminUserId, codes) };
  });
}

/**
 * Invalidate all unconsumed recovery codes and issue a new set.
 */
export async function rotateRecoveryCodes(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly count?: number;
  } & GateFields,
): Promise<GenerateRecoveryCodesResult> {
  const pool = requireOwnerAuthPool(db);
  const count = input.count ?? ADMIN_RECOVERY_CODE_COUNT;
  if (count < 1 || count > 32) {
    throw new AuthDomainError('VALIDATION', 'recovery code count must be between 1 and 32');
  }

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = generateOneRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    codes.push(code);
  }

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    await requireActiveOwner(client, input.adminUserId, { forUpdate: true });

    // Soft-consume remaining unused codes so history stays append-only.
    const revoked = await client.query<{ id: string }>(
      `UPDATE admin_recovery_codes
       SET consumed_at = now(),
           consumed_source = 'SYSTEM'
       WHERE admin_user_id = $1::uuid
         AND consumed_at IS NULL
       RETURNING id::text`,
      [input.adminUserId],
    );

    await insertRecoveryCodeHashes(client, input.adminUserId, codes);
    await insertRedactedAudit(client, {
      adminUserId: input.adminUserId,
      actionType: 'owner_admin_auth.recovery_codes_rotated',
      resourceType: 'admin_user',
      resourceId: input.adminUserId,
      reason: 'Owner recovery codes rotated',
      afterSnapshot: {
        codeCount: codes.length,
        priorUnusedRevoked: revoked.rows.length,
      },
    });
    return { status: 'ok' as const, value: createRecoveryCodeBundle(input.adminUserId, codes) };
  });
}

export interface ConsumeRecoveryCodeResult {
  readonly adminUserId: string;
  readonly email: string;
  readonly recoveryCodeId: string;
  readonly sessionId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly reauthenticatedAt: string;
}

export interface ConsumeRecoveryCodeBundle {
  readonly result: ConsumeRecoveryCodeResult;
  takeSessionTokenOnce(): string;
}

function createSessionBundle(
  result: ConsumeRecoveryCodeResult,
  sessionToken: string,
): ConsumeRecoveryCodeBundle {
  let remaining: string | null = sessionToken;
  return {
    result,
    takeSessionTokenOnce(): string {
      if (remaining === null) {
        throw new Error('session token already consumed');
      }
      const token = remaining;
      remaining = null;
      return token;
    },
  };
}

/**
 * Single-use recovery login policy:
 * - Identify Owner by adminUserId or email
 * - Consume exactly one matching unconsumed code
 * - Create a fresh admin_sessions row (reauthenticated_at = now)
 * - Replay of the same code fails closed
 * - Plaintext code is never written to audit logs
 */
export async function consumeRecoveryCode(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly recoveryCode: string;
  } & GateFields,
): Promise<ConsumeRecoveryCodeBundle> {
  const pool = requireOwnerAuthPool(db);
  const normalized = normalizeRecoveryCode(input.recoveryCode);
  if (normalized.length < 8) {
    throw new AuthDomainError('VALIDATION', 'invalid recovery code format');
  }
  const codeHash = hashAdminRecoveryCode(normalized);

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const adminUserId = await resolveAdminUserId(client, input);
    const owner = await requireActiveOwner(client, adminUserId, { forUpdate: true });
    await lockThrottleForUpdate(client, adminUserId);
    await assertNotLocked(client, adminUserId);

    const locked = await client.query<{
      id: string;
      consumed_at: Date | null;
    }>(
      `SELECT id::text, consumed_at
       FROM admin_recovery_codes
       WHERE admin_user_id = $1::uuid
         AND code_verifier_hash = $2
       FOR UPDATE`,
      [adminUserId, codeHash],
    );
    const row = locked.rows[0];
    if (row === undefined || row.consumed_at !== null) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
      };
    }

    const consumed = await client.query<{ id: string }>(
      `UPDATE admin_recovery_codes
       SET consumed_at = now(),
           consumed_source = 'WEB'
       WHERE id = $1::uuid
         AND consumed_at IS NULL
       RETURNING id::text`,
      [row.id],
    );
    if (consumed.rows[0] === undefined) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
      };
    }

    await clearAuthFailures(client, adminUserId);

    const sessionToken = generateAdminSessionToken();
    const tokenHash = hashAdminSessionToken(sessionToken);
    const idle = new Date(Date.now() + ADMIN_SESSION_IDLE_TTL_MS);
    const absolute = new Date(Date.now() + ADMIN_SESSION_ABSOLUTE_TTL_MS);
    const inserted = await client.query<{ id: string; reauthenticated_at: Date }>(
      `INSERT INTO admin_sessions (
         admin_user_id, session_token_hash, idle_expires_at, absolute_expires_at, reauthenticated_at
       ) VALUES (
         $1::uuid, $2, $3, $4, now()
       )
       RETURNING id::text, reauthenticated_at`,
      [adminUserId, tokenHash, idle.toISOString(), absolute.toISOString()],
    );
    const session = inserted.rows[0];
    if (session === undefined) {
      throw new AuthDomainError('INTERNAL', 'failed to create admin session');
    }
    await client.query(
      `UPDATE admin_users SET last_login_at = now(), last_reauthenticated_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [adminUserId],
    );
    await insertRedactedAudit(client, {
      adminUserId,
      actionType: 'owner_admin_auth.recovery_consumed',
      resourceType: 'admin_session',
      resourceId: session.id,
      reason: 'Owner admin session created via recovery code',
      afterSnapshot: {
        recoveryCodeId: row.id,
        database: gate.redactedTarget,
        // Never include plaintext recovery code.
      },
    });

    const result: ConsumeRecoveryCodeResult = {
      adminUserId,
      email: owner.email,
      recoveryCodeId: row.id,
      sessionId: session.id,
      idleExpiresAt: idle.toISOString(),
      absoluteExpiresAt: absolute.toISOString(),
      reauthenticatedAt: session.reauthenticated_at.toISOString(),
    };
    return { status: 'ok' as const, value: createSessionBundle(result, sessionToken) };
  });
}
