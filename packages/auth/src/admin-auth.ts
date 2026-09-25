/**
 * Owner admin authentication: password + TOTP enrollment, login, same-session
 * reauthentication, and logout against admin_* tables.
 *
 * Operational first enrollment is refused. Operational writes require matching
 * PostgreSQL cluster system_identifier (see docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md).
 * Mixed ACTIVE unsupported credentials (unknown types) block replace (fail-closed).
 * WEBAUTHN is a supported primary factor (Phase 13).
 */
import type { Pool, PoolClient } from 'pg';

import {
  assertConnectedDestructiveTestDatabase,
  isApprovedDestructiveTestDatabaseName,
} from '@alex-rewards/db';

import { AuthDomainError } from './errors.js';
import {
  assertPasswordPolicy,
  bytesToBase32,
  generateTotpSecretBytes,
  hashAdminPassword,
  isLocalTotpSealReference,
  sealTotpSecret,
  unsealTotpSecret,
  verifyAdminPassword,
} from './admin-password.js';
import {
  assertTotpCodeFormat,
  buildOtpAuthUri,
  generateTotpCode,
  verifyTotpCode,
  verifyTotpCodeWithStep,
} from './admin-totp.js';
import {
  ADMIN_REAUTH_MAX_AGE_MS,
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  generateAdminSessionToken,
  hashAdminSessionToken,
} from './admin-session-token.js';

type Db = Pool | PoolClient;

export const OWNER_ADMIN_AUTH_OPERATIONAL_CONFIRM =
  'I_CONFIRM_OWNER_ADMIN_AUTH_ON_ALEX_REWARDS' as const;

export const OWNER_ADMIN_AUTH_MAX_FAILURES = 5;
export const OWNER_ADMIN_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const OWNER_ADMIN_AUTH_LOCKOUT_MS = 15 * 60 * 1000;

/** Credential types this CLI/API can verify. Any other ACTIVE type blocks replace. */
const SUPPORTED_LOCAL_FACTORS = new Set(['PASSWORD', 'TOTP', 'WEBAUTHN']);

export interface OwnerAdminAuthDatabaseGate {
  readonly expectedDatabase: string;
  /**
   * Expected PostgreSQL cluster system_identifier (from pg_control_system).
   * Required for operational alex_rewards. Optional for isolated test DBs;
   * when supplied must match.
   */
  readonly expectedClusterSystemIdentifier?: string | null | undefined;
  readonly operationalConfirm?: string | null | undefined;
}

export function isPool(db: Db): db is Pool {
  return typeof (db as Pool).connect === 'function' && !('release' in db);
}

export function requireOwnerAuthPool(db: Db): Pool {
  if (!isPool(db)) {
    throw new AuthDomainError(
      'VALIDATION',
      'Owner auth APIs require a pg.Pool (pool-owned transactions); PoolClient is not accepted here',
    );
  }
  return db;
}

type AuthOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | {
      readonly status: 'auth_rejected';
      readonly error: AuthDomainError;
      readonly adminUserId: string;
    };

function isPostgresLockTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return Reflect.get(error, 'code') === '55P03';
}

/**
 * Pool-owned transaction with serialized auth outcomes and explicit lifecycle.
 * Invalid-credential paths COMMIT failure accounting before throwing.
 * System errors ROLLBACK. Untrusted connections are destroyed (not returned healthy).
 *
 * Lock hierarchy (must be respected by all work callbacks):
 *   1. admin_users (Owner) FOR UPDATE
 *   2. admin_auth_throttle FOR UPDATE
 *   3. admin_credentials FOR UPDATE (ORDER BY credential_type, id)
 *   4. admin_sessions (target or ordered bulk)
 *
 * Argon2id password / TOTP-seal work MUST run outside steps 2–4 (see login /
 * reauth prep phases), including the success path after a cryptographically valid
 * password+TOTP check. Holding the throttle row during Argon2 (valid password +
 * already-consumed TOTP replay) lets concurrent waiters hit lock_timeout and abort
 * without recordAuthFailure (R-02).
 */
export async function withPoolOwnedOwnerAuthTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<AuthOutcome<T> | T>,
): Promise<T> {
  let client: PoolClient | undefined;
  let destroyClient = false;

  try {
    try {
      client = await pool.connect();
    } catch (error) {
      throw new AuthDomainError('INTERNAL', 'failed to acquire database client', {
        cause: error,
      });
    }

    try {
      await client.query('BEGIN');
    } catch (error) {
      destroyClient = true;
      throw new AuthDomainError('INTERNAL', 'transaction BEGIN failed', { cause: error });
    }

    let raw: AuthOutcome<T> | T;
    try {
      raw = await work(client);
    } catch (error) {
      let rollbackError: unknown;
      try {
        await client.query('ROLLBACK');
      } catch (err) {
        rollbackError = err;
        destroyClient = true;
      }
      if (rollbackError !== undefined) {
        throw new AuthDomainError('INTERNAL', 'transaction rollback failed after error', {
          cause: rollbackError,
          details: {
            originalMessage: error instanceof Error ? error.message : 'unknown',
          },
        });
      }
      // Fail closed on lock_timeout — do not leave callers with a raw driver error that
      // skipped durable throttle accounting (R-02).
      if (isPostgresLockTimeout(error)) {
        throw new AuthDomainError('RATE_LIMITED', 'authentication lock contention', {
          cause: error,
        });
      }
      // Fail closed on deadlocks — do not retry auth/financial mutations here.
      throw error;
    }

    const outcome: AuthOutcome<T> =
      raw !== null &&
      typeof raw === 'object' &&
      'status' in raw &&
      (raw.status === 'ok' || raw.status === 'auth_rejected')
        ? raw
        : { status: 'ok', value: raw };

    try {
      await client.query('COMMIT');
    } catch (error) {
      destroyClient = true;
      throw new AuthDomainError(
        'INTERNAL',
        'transaction COMMIT failed; outcome may be indeterminate (not claimed rolled back)',
        {
          cause: error,
          details: {
            pendingAuthRejection: outcome.status === 'auth_rejected',
          },
        },
      );
    }

    if (outcome.status === 'ok') {
      return outcome.value;
    }
    // Auth rejection: failure counter/audit committed under locks — throw after durable COMMIT.
    throw outcome.error;
  } finally {
    if (client !== undefined) {
      if (destroyClient) {
        // node-pg: release(error) destroys the connection instead of returning it to the pool.
        client.release(new Error('owner-auth transaction connection untrusted'));
      } else {
        client.release();
      }
    }
  }
}

/**
 * @deprecated Prefer withPoolOwnedOwnerAuthTransaction(Pool). PoolClient nesting is refused.
 */
export async function withPinnedOwnerAuthTransaction<T>(
  db: Db,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'unsupported nested/caller-owned transaction: withPinnedOwnerAuthTransaction requires a Pool',
    );
  }
  return withPoolOwnedOwnerAuthTransaction(db, async (client) => {
    const value = await fn(client);
    return { status: 'ok', value };
  });
}

function redactDatabaseName(name: string): string {
  if (name.length <= 4) return '***';
  return `${name.slice(0, 2)}…${name.slice(-2)} (len=${name.length})`;
}

function redactClusterId(id: string): string {
  if (id.length <= 6) return '***';
  return `${id.slice(0, 3)}…${id.slice(-3)} (len=${id.length})`;
}

async function readClusterSystemIdentifier(db: Db): Promise<string> {
  const result = await db.query<{ system_identifier: string }>(
    `SELECT system_identifier::text AS system_identifier FROM pg_control_system()`,
  );
  const id = result.rows[0]?.system_identifier ?? '';
  if (id === '') {
    throw new AuthDomainError('INTERNAL', 'pg_control_system().system_identifier unavailable');
  }
  return id;
}

/**
 * Centralized operational default-deny for the Owner-auth subsystem.
 * Cluster system_identifier + confirm literal are NOT operational approval.
 * Owner-held endpoint trust ceremony is not implemented — refuse all ops access.
 */
export function assertOwnerAuthOperationalDefaultDeny(currentDatabase: string): void {
  if (currentDatabase === 'alex_rewards') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'Owner-auth subsystem operational access BLOCKED: Owner-held endpoint trust ceremony is not implemented — cluster identity and confirmation literal are not approval (see docs/OWNER_ADMIN_DB_IDENTITY_DESIGN.md)',
    );
  }
}

export async function assertOwnerAdminAuthDatabaseWritable(
  db: Db,
  gate: OwnerAdminAuthDatabaseGate,
): Promise<{
  readonly currentDatabase: string;
  readonly redactedTarget: string;
  readonly clusterSystemIdentifier: string;
  readonly redactedClusterId: string;
}> {
  const expected = gate.expectedDatabase.trim();
  if (expected === '') {
    throw new AuthDomainError(
      'VALIDATION',
      'expectedDatabase is required (do not rely on ambient DATABASE_URL alone)',
    );
  }
  if (expected === 'alex_rewards') {
    assertOwnerAuthOperationalDefaultDeny('alex_rewards');
  }
  const result = await db.query<{ current_database: string }>(`SELECT current_database()`);
  const current = result.rows[0]?.current_database ?? '';
  if (current === '') {
    throw new AuthDomainError('INTERNAL', 'current_database() unavailable');
  }
  // FS-01: refuse ALL Owner-auth ops entry points (not only first enroll).
  assertOwnerAuthOperationalDefaultDeny(current);

  if (current !== expected) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'database identity mismatch: connected database does not match expectedDatabase',
      {
        details: {
          expectedRedacted: redactDatabaseName(expected),
          currentRedacted: redactDatabaseName(current),
        },
      },
    );
  }

  const clusterSystemIdentifier = await readClusterSystemIdentifier(db);
  const expectedCluster = gate.expectedClusterSystemIdentifier?.trim() ?? '';

  if (!isApprovedDestructiveTestDatabaseName(current)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'Owner admin auth writes require an approved isolated test database (name ending _test or containing _phaseN)',
      { details: { currentRedacted: redactDatabaseName(current) } },
    );
  }
  if (expectedCluster !== '' && expectedCluster !== clusterSystemIdentifier) {
    throw new AuthDomainError('FORBIDDEN', 'test database cluster identity mismatch', {
      details: {
        expectedClusterRedacted: redactClusterId(expectedCluster),
        observedClusterRedacted: redactClusterId(clusterSystemIdentifier),
      },
    });
  }
  await assertConnectedDestructiveTestDatabase(db);
  return {
    currentDatabase: current,
    redactedTarget: redactDatabaseName(current),
    clusterSystemIdentifier,
    redactedClusterId: redactClusterId(clusterSystemIdentifier),
  };
}

async function requireActiveOwner(
  client: PoolClient,
  adminUserId: string,
  options?: { readonly forUpdate?: boolean },
): Promise<{ id: string; email: string; displayName: string }> {
  const lock = options?.forUpdate === true ? ' FOR UPDATE' : '';
  const admin = await client.query<{
    id: string;
    email: string;
    display_name: string;
    status: string;
  }>(
    `SELECT id::text, email, display_name, status::text FROM admin_users WHERE id = $1::uuid${lock}`,
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
  return { id: row.id, email: row.email, displayName: row.display_name };
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

async function listActiveCredentials(
  client: PoolClient,
  adminUserId: string,
): Promise<ReadonlyArray<{ id: string; credential_type: string }>> {
  const result = await client.query<{ id: string; credential_type: string }>(
    `SELECT id::text, credential_type::text
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
       AND status = 'ACTIVE'
       AND disabled_at IS NULL
     ORDER BY credential_type, created_at`,
    [adminUserId],
  );
  return result.rows;
}

function unsupportedActiveTypes(
  creds: ReadonlyArray<{ credential_type: string }>,
): string[] {
  return [
    ...new Set(
      creds
        .map((c) => c.credential_type)
        .filter((t) => !SUPPORTED_LOCAL_FACTORS.has(t)),
    ),
  ];
}

/** Fail-closed policy: any ACTIVE unsupported factor blocks mutation. WEBAUTHN is supported (Phase 13). */
export function assertNoUnsupportedActiveCredentials(
  creds: ReadonlyArray<{ credential_type: string }>,
): void {
  const unsupported = unsupportedActiveTypes(creds);
  if (unsupported.length > 0) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'ACTIVE unsupported credentials present — refuse enrollment/replacement until an approved verification mechanism exists',
      { details: { unsupportedCredentialTypes: unsupported } },
    );
  }
}

function assertUnambiguousPasswordTotpPair(
  creds: ReadonlyArray<{ id: string; credential_type: string }>,
): void {
  const passwords = creds.filter((c) => c.credential_type === 'PASSWORD');
  const totps = creds.filter((c) => c.credential_type === 'TOTP');
  if (passwords.length > 1 || totps.length > 1) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'ambiguous active credential pair — refuse until duplicates are remediated',
    );
  }
}

/** Pure policy helper — unit-tested without connecting to operational DB. */
export function assertOperationalFirstEnrollmentAllowed(
  currentDatabase: string,
  hasAnyActiveCredentials: boolean,
): void {
  if (currentDatabase === 'alex_rewards' && !hasAnyActiveCredentials) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'operational first Owner enrollment refused: no independently verifiable bootstrap authority is implemented — see docs/OWNER_ADMIN_BOOTSTRAP_DESIGN.md',
    );
  }
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

/** Lock ordering: throttle row FOR UPDATE (serialize attempts) after Owner row lock. */
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
      : 'authentication failure',
    afterSnapshot: {
      failedAttempts: failed,
      locked: lockedUntil !== null,
    },
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

async function consumeTotpStep(
  client: PoolClient,
  credentialId: string,
  step: bigint,
): Promise<boolean> {
  const updated = await client.query<{ id: string }>(
    `UPDATE admin_credentials
     SET totp_last_accepted_step = $2,
         last_used_at = now(),
         updated_at = now()
     WHERE id = $1::uuid
       AND (totp_last_accepted_step IS NULL OR totp_last_accepted_step < $2)
     RETURNING id::text`,
    [credentialId, step.toString()],
  );
  return updated.rows[0] !== undefined;
}

export interface EnrollOwnerAdminFactorsResult {
  readonly adminUserId: string;
  readonly email: string;
  readonly replaced: boolean;
  readonly currentDatabase: string;
  readonly redactedTarget: string;
  readonly sessionsRevoked: number;
}

export async function beginOwnerAdminTotpEnrollment(): Promise<{
  readonly totpSecretBytes: Uint8Array;
  readonly totpSecretBase32: string;
  readonly provisionalOtpauthUri: (email: string) => string;
}> {
  const totpSecretBytes = generateTotpSecretBytes(20);
  const totpSecretBase32 = bytesToBase32(totpSecretBytes);
  return {
    totpSecretBytes,
    totpSecretBase32,
    provisionalOtpauthUri: (email: string) =>
      buildOtpAuthUri({ secretBase32: totpSecretBase32, accountName: email }),
  };
}

/**
 * Pool-owned READ ONLY transaction for preflight UX checks.
 * Never acquires FOR UPDATE / INSERT / UPDATE / DELETE intentionally.
 * Lifecycle is phase-tracked — never classified by exception message text.
 */
export async function withPoolOwnedReadOnlyTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  let destroyClient = false;

  try {
    try {
      client = await pool.connect();
    } catch (error) {
      throw new AuthDomainError('INTERNAL', 'failed to acquire database client', { cause: error });
    }

    try {
      await client.query('BEGIN READ ONLY');
    } catch (error) {
      destroyClient = true;
      throw new AuthDomainError('INTERNAL', 'read-only transaction BEGIN failed', { cause: error });
    }

    let value: T;
    try {
      value = await work(client);
    } catch (workError) {
      // Work failed before COMMIT — always attempt ROLLBACK (do not inspect message text).
      let rollbackError: unknown;
      try {
        await client.query('ROLLBACK');
      } catch (err) {
        rollbackError = err;
        destroyClient = true;
      }
      if (rollbackError !== undefined) {
        throw new AuthDomainError('INTERNAL', 'read-only transaction rollback failed after error', {
          cause: rollbackError,
          details: {
            originalMessage: workError instanceof Error ? workError.message : 'unknown',
          },
        });
      }
      throw workError;
    }

    try {
      await client.query('COMMIT');
    } catch (error) {
      destroyClient = true;
      throw new AuthDomainError(
        'INTERNAL',
        'read-only transaction COMMIT failed; outcome may be indeterminate',
        { cause: error },
      );
    }

    return value;
  } finally {
    if (client !== undefined) {
      if (destroyClient) {
        client.release(new Error('owner-auth read-only transaction connection untrusted'));
      } else {
        client.release();
      }
    }
  }
}

/**
 * Read-only enrollment preflight (UX). Does NOT replace authoritative transactional checks.
 * Must not INSERT/UPDATE/DELETE or acquire FOR UPDATE locks.
 */
export async function preflightOwnerAdminEnrollment(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly replaceExisting?: boolean;
  } & GateFields,
): Promise<{
  readonly adminUserId: string;
  readonly email: string;
  readonly mode: 'first' | 'replace';
  readonly currentDatabase: string;
  readonly redactedTarget: string;
}> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedReadOnlyTransaction(pool, async (client) => {
    const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const adminUserId = await resolveAdminUserId(client, input);
    // No FOR UPDATE — snapshot eligibility only.
    const owner = await requireActiveOwner(client, adminUserId, { forUpdate: false });
    const throttle = await client.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM admin_auth_throttle WHERE admin_user_id = $1::uuid`,
      [adminUserId],
    );
    const lockedUntil = throttle.rows[0]?.locked_until;
    if (lockedUntil !== null && lockedUntil !== undefined && lockedUntil.getTime() > Date.now()) {
      throw new AuthDomainError('RATE_LIMITED', 'authentication temporarily locked', {
        details: { lockedUntil: lockedUntil.toISOString() },
      });
    }
    const active = await listActiveCredentials(client, adminUserId);
    assertUnambiguousPasswordTotpPair(active);
    assertNoUnsupportedActiveCredentials(active);
    const hasAnyActive = active.length > 0;
    assertOperationalFirstEnrollmentAllowed(gate.currentDatabase, hasAnyActive);
    if (hasAnyActive) {
      if (input.replaceExisting !== true) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'ACTIVE credentials already enrolled — pass replaceExisting / --replace',
        );
      }
      const hasPasswordTotp =
        active.some((c) => c.credential_type === 'PASSWORD') &&
        active.some((c) => c.credential_type === 'TOTP');
      if (!hasPasswordTotp) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'replacement requires existing ACTIVE PASSWORD+TOTP only',
        );
      }
    }
    return {
      adminUserId,
      email: owner.email,
      mode: hasAnyActive ? ('replace' as const) : ('first' as const),
      currentDatabase: gate.currentDatabase,
      redactedTarget: gate.redactedTarget,
    };
  });
}

type GateFields = {
  readonly expectedDatabase: string;
  readonly expectedClusterSystemIdentifier?: string | null;
  readonly operationalConfirm?: string | null;
};

type LockedTotpCheck =
  | {
      readonly ok: true;
      readonly passwordRowId: string;
      readonly totpRowId: string;
      readonly step: bigint;
    }
  | { readonly ok: false };

type PasswordTotpMaterial = {
  readonly passwordRowId: string;
  readonly totpRowId: string;
  readonly passwordVerifier: string;
  readonly totpSecretReference: string;
};

/**
 * Load ACTIVE PASSWORD+TOTP material without row locks.
 * Used so Argon2id verification can run outside throttle/credential FOR UPDATE
 * sections (R-02: concurrent invalid logins must still account failures under
 * lock_timeout).
 */
async function loadPasswordTotpMaterial(
  client: PoolClient,
  adminUserId: string,
): Promise<PasswordTotpMaterial | null> {
  // Login/reauth verify PASSWORD+TOTP only. Unsupported ACTIVE factors (e.g. WEBAUTHN)
  // block enrollment/replace via assertNoUnsupportedActiveCredentials elsewhere — not login.
  const creds = await client.query<{
    credential_type: string;
    password_verifier: string | null;
    totp_secret_reference: string | null;
    id: string;
  }>(
    `SELECT id::text, credential_type::text, password_verifier, totp_secret_reference
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
       AND status = 'ACTIVE'
       AND disabled_at IS NULL
       AND credential_type IN ('PASSWORD', 'TOTP')
     ORDER BY credential_type ASC, id ASC`,
    [adminUserId],
  );
  assertUnambiguousPasswordTotpPair(creds.rows);
  const passwordRow = creds.rows.find((r) => r.credential_type === 'PASSWORD');
  const totpRow = creds.rows.find((r) => r.credential_type === 'TOTP');
  if (
    passwordRow?.password_verifier === undefined ||
    passwordRow.password_verifier === null ||
    totpRow?.totp_secret_reference === undefined ||
    totpRow.totp_secret_reference === null
  ) {
    return null;
  }
  if (!isLocalTotpSealReference(totpRow.totp_secret_reference)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'TOTP secret reference format is not supported by local Owner auth CLI',
    );
  }
  return {
    passwordRowId: passwordRow.id,
    totpRowId: totpRow.id,
    passwordVerifier: passwordRow.password_verifier,
    totpSecretReference: totpRow.totp_secret_reference,
  };
}

type PasswordTotpEval =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly material: PasswordTotpMaterial;
      readonly totpSecret: Uint8Array;
      readonly step: bigint;
    };

/**
 * CPU-bound password+TOTP check (Argon2id + seal unseal). No DB locks held.
 * On success, returns the verified step + unsealed secret so the durable TX can
 * finalize without repeating Argon2 under throttle/credential locks (R-02).
 */
async function evaluatePasswordTotpFactors(
  material: PasswordTotpMaterial,
  password: string,
  totpCode: string,
  evaluationTimeMs?: number,
): Promise<PasswordTotpEval> {
  assertTotpCodeFormat(totpCode);
  const passwordOk = await verifyAdminPassword(password, material.passwordVerifier);
  if (!passwordOk) return { ok: false };
  let secret: Uint8Array;
  try {
    secret = unsealTotpSecret(password, material.totpSecretReference);
  } catch {
    return { ok: false };
  }
  const atMs = evaluationTimeMs ?? Date.now();
  const step = verifyTotpCodeWithStep(secret, totpCode, atMs);
  if (step === null) {
    secret.fill(0);
    return { ok: false };
  }
  return { ok: true, material, totpSecret: secret, step };
}

/**
 * Short critical section: lock credentials, confirm material unchanged, cheap
 * TOTP re-check with the phase-2 secret. Does not consume the step (caller may
 * still need session eligibility — FS-03 reauth ordering).
 */
async function resolvePreVerifiedPasswordTotp(
  client: PoolClient,
  adminUserId: string,
  pre: Extract<PasswordTotpEval, { ok: true }>,
  totpCode: string,
  evaluationTimeMs?: number,
): Promise<LockedTotpCheck> {
  assertTotpCodeFormat(totpCode);
  const creds = await client.query<{
    credential_type: string;
    password_verifier: string | null;
    totp_secret_reference: string | null;
    id: string;
  }>(
    `SELECT id::text, credential_type::text, password_verifier, totp_secret_reference
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
       AND status = 'ACTIVE'
       AND disabled_at IS NULL
       AND credential_type IN ('PASSWORD', 'TOTP')
     ORDER BY credential_type ASC, id ASC
     FOR UPDATE`,
    [adminUserId],
  );
  assertUnambiguousPasswordTotpPair(creds.rows);
  const passwordRow = creds.rows.find((r) => r.credential_type === 'PASSWORD');
  const totpRow = creds.rows.find((r) => r.credential_type === 'TOTP');
  if (
    passwordRow?.password_verifier === undefined ||
    passwordRow.password_verifier === null ||
    totpRow?.totp_secret_reference === undefined ||
    totpRow.totp_secret_reference === null
  ) {
    return { ok: false };
  }
  if (
    passwordRow.id !== pre.material.passwordRowId ||
    totpRow.id !== pre.material.totpRowId ||
    passwordRow.password_verifier !== pre.material.passwordVerifier ||
    totpRow.totp_secret_reference !== pre.material.totpSecretReference
  ) {
    return { ok: false };
  }
  const atMs = evaluationTimeMs ?? Date.now();
  const step = verifyTotpCodeWithStep(pre.totpSecret, totpCode, atMs);
  if (step === null) return { ok: false };
  return {
    ok: true,
    passwordRowId: passwordRow.id,
    totpRowId: totpRow.id,
    step,
  };
}

async function finalizePreVerifiedPasswordTotp(
  client: PoolClient,
  adminUserId: string,
  pre: Extract<PasswordTotpEval, { ok: true }>,
  totpCode: string,
  evaluationTimeMs?: number,
): Promise<boolean> {
  const checked = await resolvePreVerifiedPasswordTotp(
    client,
    adminUserId,
    pre,
    totpCode,
    evaluationTimeMs,
  );
  if (!checked.ok) return false;
  return consumeVerifiedPasswordTotp(client, adminUserId, checked);
}

/**
 * Lock credentials (hierarchy step 3) and verify password+TOTP without consuming the step.
 */
async function lockAndCheckPasswordTotp(
  client: PoolClient,
  input: {
    readonly adminUserId: string;
    readonly password: string;
    readonly totpCode: string;
    readonly evaluationTimeMs?: number | undefined;
  },
): Promise<LockedTotpCheck> {
  assertTotpCodeFormat(input.totpCode);
  const creds = await client.query<{
    credential_type: string;
    password_verifier: string | null;
    totp_secret_reference: string | null;
    id: string;
  }>(
    `SELECT id::text, credential_type::text, password_verifier, totp_secret_reference
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
       AND status = 'ACTIVE'
       AND disabled_at IS NULL
       AND credential_type IN ('PASSWORD', 'TOTP')
     ORDER BY credential_type ASC, id ASC
     FOR UPDATE`,
    [input.adminUserId],
  );
  assertUnambiguousPasswordTotpPair(creds.rows);
  const passwordRow = creds.rows.find((r) => r.credential_type === 'PASSWORD');
  const totpRow = creds.rows.find((r) => r.credential_type === 'TOTP');
  if (
    passwordRow?.password_verifier === undefined ||
    passwordRow.password_verifier === null ||
    totpRow?.totp_secret_reference === undefined ||
    totpRow.totp_secret_reference === null
  ) {
    return { ok: false };
  }
  if (!isLocalTotpSealReference(totpRow.totp_secret_reference)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'TOTP secret reference format is not supported by local Owner auth CLI',
    );
  }
  const passwordOk = await verifyAdminPassword(input.password, passwordRow.password_verifier);
  if (!passwordOk) return { ok: false };
  let secret: Uint8Array;
  try {
    secret = unsealTotpSecret(input.password, totpRow.totp_secret_reference);
  } catch {
    return { ok: false };
  }
  const atMs = input.evaluationTimeMs ?? Date.now();
  const step = verifyTotpCodeWithStep(secret, input.totpCode, atMs);
  if (step === null) return { ok: false };
  return {
    ok: true,
    passwordRowId: passwordRow.id,
    totpRowId: totpRow.id,
    step,
  };
}

async function consumeVerifiedPasswordTotp(
  client: PoolClient,
  adminUserId: string,
  checked: Extract<LockedTotpCheck, { ok: true }>,
): Promise<boolean> {
  const consumed = await consumeTotpStep(client, checked.totpRowId, checked.step);
  if (!consumed) return false;
  await client.query(
    `UPDATE admin_credentials SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
    [checked.passwordRowId],
  );
  await clearAuthFailures(client, adminUserId);
  return true;
}

async function tryVerifyPasswordTotp(
  client: PoolClient,
  input: {
    readonly adminUserId: string;
    readonly password: string;
    readonly totpCode: string;
    readonly evaluationTimeMs?: number | undefined;
  },
): Promise<{ ok: true } | { ok: false }> {
  const checked = await lockAndCheckPasswordTotp(client, input);
  if (!checked.ok) return { ok: false };
  const consumed = await consumeVerifiedPasswordTotp(client, input.adminUserId, checked);
  return consumed ? { ok: true } : { ok: false };
}

export async function completeOwnerAdminTotpEnrollment(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly password: string;
    readonly totpSecretBytes: Uint8Array;
    readonly totpConfirmationCode: string;
    readonly replaceExisting?: boolean;
    readonly currentPassword?: string | null;
    readonly currentTotpCode?: string | null;
    readonly evaluationTimeMs?: number;
  } & GateFields,
): Promise<EnrollOwnerAdminFactorsResult> {
  const pool = requireOwnerAuthPool(db);
  const confirmationStep = verifyTotpCodeWithStep(
    input.totpSecretBytes,
    input.totpConfirmationCode,
    input.evaluationTimeMs ?? Date.now(),
  );
  if (confirmationStep === null) {
    throw new AuthDomainError('VALIDATION', 'TOTP confirmation code does not match new secret');
  }
  assertPasswordPolicy(input.password);

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

    const active = await listActiveCredentials(client, adminUserId);
    assertUnambiguousPasswordTotpPair(active);
    assertNoUnsupportedActiveCredentials(active);

    const hasAnyActive = active.length > 0;
    const hasPasswordTotp =
      active.some((c) => c.credential_type === 'PASSWORD') &&
      active.some((c) => c.credential_type === 'TOTP');

    if (gate.currentDatabase === 'alex_rewards' && !hasAnyActive) {
      assertOperationalFirstEnrollmentAllowed(gate.currentDatabase, hasAnyActive);
    }

    let replaced = false;
    if (hasAnyActive) {
      if (input.replaceExisting !== true) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'ACTIVE credentials already enrolled — pass replaceExisting with current password+TOTP (unsupported types must not be present)',
          {
            details: {
              activeCredentialTypes: [...new Set(active.map((c) => c.credential_type))],
            },
          },
        );
      }
      if (!hasPasswordTotp) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'replacement requires existing ACTIVE PASSWORD+TOTP only',
        );
      }
      const verified = await tryVerifyPasswordTotp(client, {
        adminUserId,
        password: input.currentPassword ?? '',
        totpCode: input.currentTotpCode ?? '',
        evaluationTimeMs: input.evaluationTimeMs,
      });
      if (!verified.ok) {
        await recordAuthFailure(client, adminUserId);
        return {
          status: 'auth_rejected',
          adminUserId,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }
      replaced = true;
    }

    const passwordVerifier = await hashAdminPassword(input.password);
    const totpRef = sealTotpSecret(input.password, input.totpSecretBytes);

    let sessionsRevoked = 0;
    if (replaced) {
      await client.query(
        `UPDATE admin_credentials
         SET status = 'DISABLED', disabled_at = now(), updated_at = now()
         WHERE admin_user_id = $1::uuid
           AND status = 'ACTIVE'
           AND credential_type IN ('PASSWORD', 'TOTP')
           AND disabled_at IS NULL`,
        [adminUserId],
      );
      // Lock sessions in stable id order before revoke (hierarchy step 4).
      const lockedSessions = await client.query<{ id: string }>(
        `SELECT id::text
         FROM admin_sessions
         WHERE admin_user_id = $1::uuid
           AND revoked_at IS NULL
         ORDER BY id ASC
         FOR UPDATE`,
        [adminUserId],
      );
      if (lockedSessions.rows.length > 0) {
        const revoked = await client.query<{ id: string }>(
          `UPDATE admin_sessions
           SET revoked_at = now(),
               revoked_reason = 'SECURITY_EVENT'
           WHERE id = ANY($1::uuid[])
             AND revoked_at IS NULL
           RETURNING id::text`,
          [lockedSessions.rows.map((r) => r.id)],
        );
        sessionsRevoked = revoked.rows.length;
      }
    }

    await client.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, label, password_verifier, status
       ) VALUES ($1::uuid, 'PASSWORD', 'owner-local-password', $2, 'ACTIVE')`,
      [adminUserId, passwordVerifier],
    );
    const totpInsert = await client.query<{ id: string }>(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, label, totp_secret_reference, status,
         totp_last_accepted_step
       ) VALUES ($1::uuid, 'TOTP', 'owner-local-totp', $2, 'ACTIVE', $3)
       RETURNING id::text`,
      [adminUserId, totpRef, confirmationStep.toString()],
    );
    if (totpInsert.rows[0] === undefined) {
      throw new AuthDomainError('INTERNAL', 'failed to insert TOTP credential');
    }

    await clearAuthFailures(client, adminUserId);
    await insertRedactedAudit(client, {
      adminUserId,
      actionType: replaced
        ? 'owner_admin_auth.credential_replaced'
        : 'owner_admin_auth.credential_enrolled',
      resourceType: 'admin_user',
      resourceId: adminUserId,
      reason: replaced
        ? 'Owner password+TOTP replaced; prior sessions revoked'
        : 'Owner password+TOTP enrolled (isolated/non-ops first enroll)',
      afterSnapshot: {
        replaced,
        sessionsRevoked,
        database: gate.redactedTarget,
        cluster: gate.redactedClusterId,
        factors: ['PASSWORD', 'TOTP'],
      },
    });

    return {
      status: 'ok',
      value: {
        adminUserId,
        email: owner.email,
        replaced,
        currentDatabase: gate.currentDatabase,
        redactedTarget: gate.redactedTarget,
        sessionsRevoked,
      },
    };
  });
}

export async function verifyOwnerAdminPasswordAndTotp(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly password: string;
    readonly totpCode: string;
    readonly evaluationTimeMs?: number;
  } & GateFields,
): Promise<void> {
  const pool = requireOwnerAuthPool(db);
  const prep = await withPoolOwnedReadOnlyTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    await requireActiveOwner(client, input.adminUserId, { forUpdate: false });
    const material = await loadPasswordTotpMaterial(client, input.adminUserId);
    return { material };
  });

  const factors =
    prep.material !== null
      ? await evaluatePasswordTotpFactors(
          prep.material,
          input.password,
          input.totpCode,
          input.evaluationTimeMs,
        )
      : ({ ok: false } as const);

  try {
    await withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
      await assertOwnerAdminAuthDatabaseWritable(client, {
        expectedDatabase: input.expectedDatabase,
        expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
        operationalConfirm: input.operationalConfirm ?? null,
      });
      await requireActiveOwner(client, input.adminUserId, { forUpdate: true });
      await lockThrottleForUpdate(client, input.adminUserId);
      await assertNotLocked(client, input.adminUserId);
      if (!factors.ok) {
        await recordAuthFailure(client, input.adminUserId);
        return {
          status: 'auth_rejected' as const,
          adminUserId: input.adminUserId,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }
      // Success: finalize under locks without Argon2 (defeat TOCTOU / replay).
      const finalized = await finalizePreVerifiedPasswordTotp(
        client,
        input.adminUserId,
        factors,
        input.totpCode,
        input.evaluationTimeMs,
      );
      if (!finalized) {
        await recordAuthFailure(client, input.adminUserId);
        return {
          status: 'auth_rejected' as const,
          adminUserId: input.adminUserId,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }
      return { status: 'ok' as const, value: undefined };
    });
  } finally {
    if (factors.ok) factors.totpSecret.fill(0);
  }
}

export interface LoginOwnerAdminInput extends GateFields {
  readonly adminUserId?: string | null;
  readonly email?: string | null;
  readonly password: string;
  readonly totpCode: string;
  readonly evaluationTimeMs?: number;
}

export interface LoginOwnerAdminResult {
  readonly adminUserId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly reauthenticatedAt: string;
  readonly currentDatabase: string;
  readonly redactedTarget: string;
}

/** Session token is not a JSON field — take once for interactive TTY handoff. */
export interface LoginOwnerAdminBundle {
  readonly result: LoginOwnerAdminResult;
  takeSessionTokenOnce(): string;
}

function createSessionTokenBundle(
  result: LoginOwnerAdminResult,
  sessionToken: string,
): LoginOwnerAdminBundle {
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

export async function loginOwnerAdmin(
  db: Db,
  input: LoginOwnerAdminInput,
): Promise<LoginOwnerAdminBundle> {
  const pool = requireOwnerAuthPool(db);

  // Phase 1: unlocked reads. Argon2 must not run under throttle FOR UPDATE (R-02).
  const prep = await withPoolOwnedReadOnlyTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const adminUserId = await resolveAdminUserId(client, input);
    await requireActiveOwner(client, adminUserId, { forUpdate: false });
    const material = await loadPasswordTotpMaterial(client, adminUserId);
    return { adminUserId, material };
  });

  // Phase 2: CPU-bound factor check outside any transaction / row locks.
  const factors =
    prep.material !== null
      ? await evaluatePasswordTotpFactors(
          prep.material,
          input.password,
          input.totpCode,
          input.evaluationTimeMs,
        )
      : ({ ok: false } as const);

  // Phase 3: short durable TX — serialize lockout accounting / session create only.
  // No Argon2 under locks (including TOTP-replay success path).
  try {
    return await withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
      const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
        expectedDatabase: input.expectedDatabase,
        expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
        operationalConfirm: input.operationalConfirm ?? null,
      });
      const owner = await requireActiveOwner(client, prep.adminUserId, { forUpdate: true });
      await lockThrottleForUpdate(client, prep.adminUserId);
      await assertNotLocked(client, prep.adminUserId);

      if (!factors.ok) {
        await recordAuthFailure(client, prep.adminUserId);
        return {
          status: 'auth_rejected',
          adminUserId: prep.adminUserId,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }

      const finalized = await finalizePreVerifiedPasswordTotp(
        client,
        prep.adminUserId,
        factors,
        input.totpCode,
        input.evaluationTimeMs,
      );
      if (!finalized) {
        await recordAuthFailure(client, prep.adminUserId);
        return {
          status: 'auth_rejected',
          adminUserId: prep.adminUserId,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }

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
        [prep.adminUserId, tokenHash, idle.toISOString(), absolute.toISOString()],
      );
      const session = inserted.rows[0];
      if (session === undefined) {
        throw new AuthDomainError('INTERNAL', 'failed to create admin session');
      }
      await client.query(
        `UPDATE admin_users SET last_login_at = now(), last_reauthenticated_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [prep.adminUserId],
      );
      await insertRedactedAudit(client, {
        adminUserId: prep.adminUserId,
        actionType: 'owner_admin_auth.session_created',
        resourceType: 'admin_session',
        resourceId: session.id,
        reason: 'Owner admin session created',
        afterSnapshot: {
          database: gate.redactedTarget,
          cluster: gate.redactedClusterId,
          idleExpiresAt: idle.toISOString(),
          absoluteExpiresAt: absolute.toISOString(),
        },
      });

      const result: LoginOwnerAdminResult = {
        adminUserId: prep.adminUserId,
        email: owner.email,
        sessionId: session.id,
        idleExpiresAt: idle.toISOString(),
        absoluteExpiresAt: absolute.toISOString(),
        reauthenticatedAt: session.reauthenticated_at.toISOString(),
        currentDatabase: gate.currentDatabase,
        redactedTarget: gate.redactedTarget,
      };
      return { status: 'ok', value: createSessionTokenBundle(result, sessionToken) };
    });
  } finally {
    if (factors.ok) factors.totpSecret.fill(0);
  }
}

export interface ReauthOwnerAdminSessionInput extends GateFields {
  readonly sessionToken: string;
  readonly password: string;
  readonly totpCode: string;
  readonly evaluationTimeMs?: number;
}

export interface ReauthOwnerAdminSessionResult {
  readonly adminUserId: string;
  readonly sessionId: string;
  readonly reauthenticatedAt: string;
  readonly reauthMaxAgeMs: number;
  readonly redactedTarget: string;
}

export async function reauthenticateOwnerAdminSession(
  db: Db,
  input: ReauthOwnerAdminSessionInput,
): Promise<ReauthOwnerAdminSessionResult> {
  const pool = requireOwnerAuthPool(db);
  const tokenHash = hashAdminSessionToken(input.sessionToken);

  const prep = await withPoolOwnedReadOnlyTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const peek = await client.query<{
      id: string;
      admin_user_id: string;
    }>(
      `SELECT id::text, admin_user_id::text
       FROM admin_sessions
       WHERE session_token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const peeked = peek.rows[0];
    if (peeked === undefined) {
      throw new AuthDomainError('UNAUTHENTICATED', 'session not found');
    }
    await requireActiveOwner(client, peeked.admin_user_id, { forUpdate: false });
    const material = await loadPasswordTotpMaterial(client, peeked.admin_user_id);
    return { peeked, material };
  });

  const factors =
    prep.material !== null
      ? await evaluatePasswordTotpFactors(
          prep.material,
          input.password,
          input.totpCode,
          input.evaluationTimeMs,
        )
      : ({ ok: false } as const);

  try {
    return await withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
      const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
        expectedDatabase: input.expectedDatabase,
        expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
        operationalConfirm: input.operationalConfirm ?? null,
      });

      // Hierarchy (FS-03): Owner → throttle → credentials resolve → session → consume.
      // No Argon2 under locks (R-02 success-path / TOTP-replay contention).
      await requireActiveOwner(client, prep.peeked.admin_user_id, { forUpdate: true });
      await lockThrottleForUpdate(client, prep.peeked.admin_user_id);
      await assertNotLocked(client, prep.peeked.admin_user_id);

      if (!factors.ok) {
        await recordAuthFailure(client, prep.peeked.admin_user_id);
        return {
          status: 'auth_rejected',
          adminUserId: prep.peeked.admin_user_id,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }

      const checked = await resolvePreVerifiedPasswordTotp(
        client,
        prep.peeked.admin_user_id,
        factors,
        input.totpCode,
        input.evaluationTimeMs,
      );
      if (!checked.ok) {
        await recordAuthFailure(client, prep.peeked.admin_user_id);
        return {
          status: 'auth_rejected',
          adminUserId: prep.peeked.admin_user_id,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }

      const session = await client.query<{
        id: string;
        admin_user_id: string;
        session_token_hash: string;
        idle_expires_at: Date;
        absolute_expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id::text, admin_user_id::text, session_token_hash, idle_expires_at, absolute_expires_at, revoked_at
         FROM admin_sessions
         WHERE id = $1::uuid
         FOR UPDATE
         LIMIT 1`,
        [prep.peeked.id],
      );
      const row = session.rows[0];
      if (row === undefined) {
        throw new AuthDomainError('UNAUTHENTICATED', 'session not found');
      }
      if (row.session_token_hash !== tokenHash || row.admin_user_id !== prep.peeked.admin_user_id) {
        throw new AuthDomainError('UNAUTHENTICATED', 'session not found');
      }
      if (row.revoked_at !== null) {
        throw new AuthDomainError('SESSION_REVOKED', 'session is revoked');
      }
      const now = Date.now();
      if (row.idle_expires_at.getTime() <= now || row.absolute_expires_at.getTime() <= now) {
        throw new AuthDomainError('SESSION_EXPIRED', 'session is expired');
      }

      const consumed = await consumeVerifiedPasswordTotp(client, row.admin_user_id, checked);
      if (!consumed) {
        await recordAuthFailure(client, row.admin_user_id);
        return {
          status: 'auth_rejected',
          adminUserId: row.admin_user_id,
          error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
        };
      }

      const idle = new Date(now + ADMIN_SESSION_IDLE_TTL_MS);
      const updated = await client.query<{ reauthenticated_at: Date }>(
        `UPDATE admin_sessions
         SET reauthenticated_at = now(),
             last_seen_at = now(),
             idle_expires_at = LEAST($2::timestamptz, absolute_expires_at)
         WHERE id = $1::uuid
           AND revoked_at IS NULL
           AND session_token_hash = $3
         RETURNING reauthenticated_at`,
        [row.id, idle.toISOString(), tokenHash],
      );
      const reauthAt = updated.rows[0]?.reauthenticated_at;
      if (reauthAt === undefined) {
        throw new AuthDomainError('SESSION_REVOKED', 'session is revoked');
      }
      await client.query(
        `UPDATE admin_users SET last_reauthenticated_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [row.admin_user_id],
      );
      await insertRedactedAudit(client, {
        adminUserId: row.admin_user_id,
        actionType: 'owner_admin_auth.reauthenticated',
        resourceType: 'admin_session',
        resourceId: row.id,
        reason: 'Owner admin session reauthenticated',
        afterSnapshot: { database: gate.redactedTarget, cluster: gate.redactedClusterId },
      });

      return {
        status: 'ok',
        value: {
          adminUserId: row.admin_user_id,
          sessionId: row.id,
          reauthenticatedAt: reauthAt.toISOString(),
          reauthMaxAgeMs: ADMIN_REAUTH_MAX_AGE_MS,
          redactedTarget: gate.redactedTarget,
        },
      };
    });
  } finally {
    if (factors.ok) factors.totpSecret.fill(0);
  }
}

export async function logoutOwnerAdminSession(
  db: Db,
  input: { readonly sessionToken: string } & GateFields,
): Promise<{ readonly sessionId: string; readonly revoked: boolean; readonly redactedTarget: string }> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const tokenHash = hashAdminSessionToken(input.sessionToken);

    const peek = await client.query<{ id: string; admin_user_id: string }>(
      `SELECT id::text, admin_user_id::text
       FROM admin_sessions
       WHERE session_token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const peeked = peek.rows[0];
    if (peeked === undefined) {
      throw new AuthDomainError('UNAUTHENTICATED', 'session not found or already revoked');
    }

    // Hierarchy: Owner then session (no session-before-owner).
    await requireActiveOwner(client, peeked.admin_user_id, { forUpdate: true });

    const locked = await client.query<{ id: string; admin_user_id: string; revoked_at: Date | null }>(
      `SELECT id::text, admin_user_id::text, revoked_at
       FROM admin_sessions
       WHERE id = $1::uuid
       FOR UPDATE
       LIMIT 1`,
      [peeked.id],
    );
    const row = locked.rows[0];
    if (row === undefined || row.admin_user_id !== peeked.admin_user_id) {
      throw new AuthDomainError('UNAUTHENTICATED', 'session not found or already revoked');
    }
    if (row.revoked_at !== null) {
      throw new AuthDomainError('UNAUTHENTICATED', 'session not found or already revoked');
    }

    const updated = await client.query<{ id: string; admin_user_id: string }>(
      `UPDATE admin_sessions
       SET revoked_at = now(),
           revoked_reason = 'USER_LOGOUT'
       WHERE id = $1::uuid
         AND session_token_hash = $2
         AND revoked_at IS NULL
       RETURNING id::text, admin_user_id::text`,
      [row.id, tokenHash],
    );
    const out = updated.rows[0];
    if (out === undefined) {
      throw new AuthDomainError('UNAUTHENTICATED', 'session not found or already revoked');
    }
    await insertRedactedAudit(client, {
      adminUserId: out.admin_user_id,
      actionType: 'owner_admin_auth.session_revoked',
      resourceType: 'admin_session',
      resourceId: out.id,
      reason: 'Owner admin session logout',
      afterSnapshot: {
        database: gate.redactedTarget,
        cluster: gate.redactedClusterId,
        reason: 'USER_LOGOUT',
      },
    });
    return {
      status: 'ok',
      value: { sessionId: out.id, revoked: true, redactedTarget: gate.redactedTarget },
    };
  });
}

export function isAdminSessionReauthFresh(
  reauthenticatedAt: Date | string | null,
  nowMs: number = Date.now(),
  maxAgeMs: number = ADMIN_REAUTH_MAX_AGE_MS,
): boolean {
  if (reauthenticatedAt === null) return false;
  const ts =
    typeof reauthenticatedAt === 'string'
      ? Date.parse(reauthenticatedAt)
      : reauthenticatedAt.getTime();
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= maxAgeMs;
}

export { generateTotpCode, verifyTotpCode, buildOtpAuthUri, bytesToBase32 };
