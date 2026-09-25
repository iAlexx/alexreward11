/**
 * Owner Admin WebAuthn (Passkey) primary factor.
 * Challenges are one-time DB rows with expiry. RP ID / origin come from runtime
 * config — never invent production defaults (OWNER_DECISION_REQUIRED).
 */
import type { Pool, PoolClient } from 'pg';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { AuthDomainError } from './errors.js';
import {
  OWNER_ADMIN_AUTH_FAILURE_WINDOW_MS,
  OWNER_ADMIN_AUTH_LOCKOUT_MS,
  OWNER_ADMIN_AUTH_MAX_FAILURES,
  assertOwnerAdminAuthDatabaseWritable,
  requireOwnerAuthPool,
  withPoolOwnedOwnerAuthTransaction,
  withPoolOwnedReadOnlyTransaction,
  type OwnerAdminAuthDatabaseGate,
} from './admin-auth.js';
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  generateAdminSessionToken,
  hashAdminSessionToken,
} from './admin-session-token.js';

type Db = Pool | PoolClient;

export const ADMIN_WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type AdminWebAuthnChallengePurpose = 'REGISTRATION' | 'AUTHENTICATION' | 'REAUTH';

export interface AdminWebAuthnRpConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origin: string;
}

export interface AdminWebAuthnCredentialRow {
  readonly id: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: bigint;
  readonly transports: AuthenticatorTransportFuture[] | undefined;
}

type GateFields = OwnerAdminAuthDatabaseGate;

/**
 * Resolve RP config. Outside local/test, empty RP ID / origin fail closed
 * (OWNER_DECISION_REQUIRED). Local/test may use fixture defaults only when unset.
 */
export function resolveAdminWebAuthnRpConfig(input: {
  readonly deploymentEnv: 'local' | 'test' | 'staging' | 'production' | string;
  readonly rpId?: string | null;
  readonly rpName?: string | null;
  readonly origin?: string | null;
}): AdminWebAuthnRpConfig {
  const outsideLocal = input.deploymentEnv !== 'local' && input.deploymentEnv !== 'test';
  const rpId = (input.rpId ?? '').trim();
  const origin = (input.origin ?? '').trim();
  const rpName = (input.rpName ?? '').trim() || 'ALEx Rewards Owner Admin';

  if (rpId === '' || origin === '') {
    if (outsideLocal) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'ADMIN_WEBAUTHN_RP_ID and ADMIN_WEBAUTHN_ORIGIN are OWNER_DECISION_REQUIRED outside local/test',
      );
    }
    return {
      rpId: rpId === '' ? 'localhost' : rpId,
      origin: origin === '' ? 'http://localhost:3001' : origin,
      rpName,
    };
  }

  if (outsideLocal) {
    const lower = rpId.toLowerCase();
    if (
      lower === 'localhost' ||
      lower === '127.0.0.1' ||
      lower.endsWith('.localhost') ||
      lower.endsWith('.local.test')
    ) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'local fixture ADMIN_WEBAUTHN_RP_ID cannot be used outside local/test',
      );
    }
  }

  return { rpId, origin, rpName };
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
      : 'WebAuthn authentication failure',
    afterSnapshot: { failedAttempts: failed, locked: lockedUntil !== null, factor: 'WEBAUTHN' },
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

async function listActiveWebAuthnCredentials(
  client: PoolClient,
  adminUserId: string,
): Promise<AdminWebAuthnCredentialRow[]> {
  const result = await client.query<{
    id: string;
    webauthn_credential_id: string;
    webauthn_public_key: string;
    webauthn_sign_count: string | null;
  }>(
    `SELECT id::text, webauthn_credential_id, webauthn_public_key, webauthn_sign_count::text
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
       AND credential_type = 'WEBAUTHN'
       AND status = 'ACTIVE'
       AND disabled_at IS NULL
       AND webauthn_credential_id IS NOT NULL
       AND webauthn_public_key IS NOT NULL
     ORDER BY created_at ASC`,
    [adminUserId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    credentialId: row.webauthn_credential_id,
    publicKey: row.webauthn_public_key,
    signCount: BigInt(row.webauthn_sign_count ?? '0'),
    transports: undefined,
  }));
}

function decodePublicKeyBytes(stored: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(stored, 'base64url');
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

function encodePublicKeyBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function storeChallenge(
  client: PoolClient,
  input: {
    readonly adminUserId: string | null;
    readonly purpose: AdminWebAuthnChallengePurpose;
    readonly challenge: string;
    readonly ttlMs?: number;
  },
): Promise<{ readonly challengeId: string; readonly expiresAt: string }> {
  const ttl = input.ttlMs ?? ADMIN_WEBAUTHN_CHALLENGE_TTL_MS;
  const expires = new Date(Date.now() + ttl);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO admin_webauthn_challenges (admin_user_id, purpose, challenge, expires_at)
     VALUES ($1::uuid, $2, $3, $4::timestamptz)
     RETURNING id::text`,
    [input.adminUserId, input.purpose, input.challenge, expires.toISOString()],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new AuthDomainError('INTERNAL', 'failed to store WebAuthn challenge');
  }
  return { challengeId: id, expiresAt: expires.toISOString() };
}

/**
 * One-time consume: marks challenge consumed under row lock. Rejects expired/replayed.
 */
async function consumeChallenge(
  client: PoolClient,
  input: {
    readonly challenge: string;
    readonly purpose: AdminWebAuthnChallengePurpose;
    readonly adminUserId?: string | null;
  },
): Promise<{ readonly challengeId: string; readonly adminUserId: string | null }> {
  const locked = await client.query<{
    id: string;
    admin_user_id: string | null;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id::text, admin_user_id::text, expires_at, consumed_at
     FROM admin_webauthn_challenges
     WHERE challenge = $1
       AND purpose = $2
     FOR UPDATE`,
    [input.challenge, input.purpose],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'WebAuthn challenge not found');
  }
  if (row.consumed_at !== null) {
    throw new AuthDomainError('UNAUTHENTICATED', 'WebAuthn challenge already consumed');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AuthDomainError('UNAUTHENTICATED', 'WebAuthn challenge expired');
  }
  if (
    input.adminUserId !== undefined &&
    input.adminUserId !== null &&
    row.admin_user_id !== null &&
    row.admin_user_id !== input.adminUserId
  ) {
    throw new AuthDomainError('UNAUTHENTICATED', 'WebAuthn challenge admin mismatch');
  }
  const updated = await client.query<{ id: string }>(
    `UPDATE admin_webauthn_challenges
     SET consumed_at = now()
     WHERE id = $1::uuid
       AND consumed_at IS NULL
     RETURNING id::text`,
    [row.id],
  );
  if (updated.rows[0] === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'WebAuthn challenge already consumed');
  }
  return { challengeId: row.id, adminUserId: row.admin_user_id };
}

export interface BeginWebAuthnRegistrationResult {
  readonly adminUserId: string;
  readonly options: PublicKeyCredentialCreationOptionsJSON;
  readonly challengeId: string;
  readonly expiresAt: string;
}

export async function beginWebAuthnRegistration(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnRegistrationResult> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const owner = await requireActiveOwner(client, input.adminUserId, { forUpdate: true });
    await lockThrottleForUpdate(client, input.adminUserId);
    await assertNotLocked(client, input.adminUserId);

    const existing = await listActiveWebAuthnCredentials(client, input.adminUserId);
    const options = await generateRegistrationOptions({
      rpName: input.rp.rpName,
      rpID: input.rp.rpId,
      userName: owner.email,
      userID: new TextEncoder().encode(owner.id),
      userDisplayName: owner.displayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        type: 'public-key' as const,
      })),
    });

    const stored = await storeChallenge(client, {
      adminUserId: owner.id,
      purpose: 'REGISTRATION',
      challenge: options.challenge,
    });

    await insertRedactedAudit(client, {
      adminUserId: owner.id,
      actionType: 'owner_admin_auth.webauthn_register_begin',
      resourceType: 'admin_user',
      resourceId: owner.id,
      reason: 'WebAuthn registration options issued',
      afterSnapshot: { challengeId: stored.challengeId, rpId: input.rp.rpId },
    });

    return {
      status: 'ok' as const,
      value: {
        adminUserId: owner.id,
        options,
        challengeId: stored.challengeId,
        expiresAt: stored.expiresAt,
      },
    };
  });
}

export interface FinishWebAuthnRegistrationResult {
  readonly adminUserId: string;
  readonly credentialRowId: string;
  readonly credentialId: string;
  readonly signCount: number;
}

export async function finishWebAuthnRegistration(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly response: RegistrationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
    readonly label?: string | null;
  } & GateFields,
): Promise<FinishWebAuthnRegistrationResult> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    await requireActiveOwner(client, input.adminUserId, { forUpdate: true });
    await lockThrottleForUpdate(client, input.adminUserId);
    await assertNotLocked(client, input.adminUserId);

    const expectedChallenge =
      typeof input.response.response.clientDataJSON === 'string'
        ? (() => {
            try {
              const json = Buffer.from(input.response.response.clientDataJSON, 'base64url').toString(
                'utf8',
              );
              const parsed = JSON.parse(json) as { challenge?: string };
              return typeof parsed.challenge === 'string' ? parsed.challenge : '';
            } catch {
              return '';
            }
          })()
        : '';

    if (expectedChallenge === '') {
      await recordAuthFailure(client, input.adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId: input.adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'invalid WebAuthn registration response'),
      };
    }

    try {
      await consumeChallenge(client, {
        challenge: expectedChallenge,
        purpose: 'REGISTRATION',
        adminUserId: input.adminUserId,
      });
    } catch (error) {
      await recordAuthFailure(client, input.adminUserId);
      if (error instanceof AuthDomainError) {
        return {
          status: 'auth_rejected' as const,
          adminUserId: input.adminUserId,
          error,
        };
      }
      throw error;
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge,
        expectedOrigin: input.rp.origin,
        expectedRPID: input.rp.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      await recordAuthFailure(client, input.adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId: input.adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn registration verification failed', {
          cause: error,
        }),
      };
    }

    if (!verification.verified || verification.registrationInfo === undefined) {
      await recordAuthFailure(client, input.adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId: input.adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn registration not verified'),
      };
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;
    const publicKeyB64 = encodePublicKeyBytes(credential.publicKey);
    const signCount = Number(credential.counter);
    if (!Number.isFinite(signCount) || signCount < 0) {
      throw new AuthDomainError('INTERNAL', 'invalid WebAuthn sign count from registration');
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, label,
         webauthn_credential_id, webauthn_public_key, webauthn_sign_count, webauthn_aaguid,
         status
       ) VALUES (
         $1::uuid, 'WEBAUTHN', $2, $3, $4, $5, $6, 'ACTIVE'
       )
       RETURNING id::text`,
      [
        input.adminUserId,
        input.label?.trim() || 'owner-webauthn',
        credential.id,
        publicKeyB64,
        signCount,
        aaguid ?? null,
      ],
    );
    const credentialRowId = inserted.rows[0]?.id;
    if (credentialRowId === undefined) {
      throw new AuthDomainError('INTERNAL', 'failed to store WebAuthn credential');
    }

    await clearAuthFailures(client, input.adminUserId);
    await insertRedactedAudit(client, {
      adminUserId: input.adminUserId,
      actionType: 'owner_admin_auth.webauthn_registered',
      resourceType: 'admin_credential',
      resourceId: credentialRowId,
      reason: 'Owner WebAuthn credential enrolled',
      afterSnapshot: {
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        signCount,
        // Never log credential public key material.
      },
    });

    return {
      status: 'ok' as const,
      value: {
        adminUserId: input.adminUserId,
        credentialRowId,
        credentialId: credential.id,
        signCount,
      },
    };
  });
}

export interface BeginWebAuthnAuthenticationResult {
  readonly adminUserId: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
  readonly challengeId: string;
  readonly expiresAt: string;
}

async function beginWebAuthnCeremony(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly purpose: 'AUTHENTICATION' | 'REAUTH';
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnAuthenticationResult> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });
    const adminUserId = await resolveAdminUserId(client, input);
    await requireActiveOwner(client, adminUserId, { forUpdate: true });
    await lockThrottleForUpdate(client, adminUserId);
    await assertNotLocked(client, adminUserId);

    const creds = await listActiveWebAuthnCredentials(client, adminUserId);
    if (creds.length === 0) {
      throw new AuthDomainError('FORBIDDEN', 'no ACTIVE WebAuthn credentials enrolled');
    }

    const options = await generateAuthenticationOptions({
      rpID: input.rp.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => {
        const base: { id: string; transports?: AuthenticatorTransportFuture[] } = {
          id: c.credentialId,
        };
        if (c.transports !== undefined) {
          base.transports = c.transports;
        }
        return base;
      }),
    });

    const stored = await storeChallenge(client, {
      adminUserId,
      purpose: input.purpose,
      challenge: options.challenge,
    });

    await insertRedactedAudit(client, {
      adminUserId,
      actionType:
        input.purpose === 'REAUTH'
          ? 'owner_admin_auth.webauthn_reauth_begin'
          : 'owner_admin_auth.webauthn_login_begin',
      resourceType: 'admin_user',
      resourceId: adminUserId,
      reason: `WebAuthn ${input.purpose.toLowerCase()} options issued`,
      afterSnapshot: { challengeId: stored.challengeId, rpId: input.rp.rpId },
    });

    return {
      status: 'ok' as const,
      value: {
        adminUserId,
        options,
        challengeId: stored.challengeId,
        expiresAt: stored.expiresAt,
      },
    };
  });
}

export async function beginWebAuthnAuthentication(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnAuthenticationResult> {
  return beginWebAuthnCeremony(db, { ...input, purpose: 'AUTHENTICATION' });
}

export async function beginWebAuthnReauth(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<BeginWebAuthnAuthenticationResult> {
  return beginWebAuthnCeremony(db, {
    ...input,
    adminUserId: input.adminUserId,
    purpose: 'REAUTH',
  });
}

function extractClientChallenge(response: AuthenticationResponseJSON): string {
  try {
    const json = Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { challenge?: string };
    return typeof parsed.challenge === 'string' ? parsed.challenge : '';
  } catch {
    return '';
  }
}

export interface FinishWebAuthnAuthenticationResult {
  readonly adminUserId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly reauthenticatedAt: string;
  readonly credentialRowId: string;
  readonly newSignCount: number;
}

export interface FinishWebAuthnAuthenticationBundle {
  readonly result: FinishWebAuthnAuthenticationResult;
  takeSessionTokenOnce(): string;
}

function createSessionTokenBundle(
  result: FinishWebAuthnAuthenticationResult,
  sessionToken: string,
): FinishWebAuthnAuthenticationBundle {
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
 * Verify assertion, update sign_count (reject replay / non-increasing), optionally create session.
 */
async function finishWebAuthnAssertion(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly response: AuthenticationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
    readonly purpose: 'AUTHENTICATION' | 'REAUTH';
    readonly createSession: boolean;
    readonly existingSessionToken?: string | null;
  } & GateFields,
): Promise<
  | FinishWebAuthnAuthenticationBundle
  | { readonly adminUserId: string; readonly sessionId: string; readonly reauthenticatedAt: string }
> {
  const pool = requireOwnerAuthPool(db);
  const challengeFromClient = extractClientChallenge(input.response);
  if (challengeFromClient === '') {
    throw new AuthDomainError('UNAUTHENTICATED', 'invalid WebAuthn authentication response');
  }

  type TxResult =
    | FinishWebAuthnAuthenticationBundle
    | { readonly adminUserId: string; readonly sessionId: string; readonly reauthenticatedAt: string };

  return withPoolOwnedOwnerAuthTransaction<TxResult>(pool, async (client) => {
    const gate = await assertOwnerAdminAuthDatabaseWritable(client, {
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
      operationalConfirm: input.operationalConfirm ?? null,
    });

    let adminUserId: string;
    if (input.adminUserId !== undefined && input.adminUserId !== null && input.adminUserId.trim() !== '') {
      adminUserId = input.adminUserId.trim();
    } else if (input.email !== undefined && input.email !== null && input.email.trim() !== '') {
      adminUserId = await resolveAdminUserId(client, { email: input.email });
    } else {
      // Discover admin from credential id when not supplied.
      const credLookup = await client.query<{ admin_user_id: string }>(
        `SELECT admin_user_id::text
         FROM admin_credentials
         WHERE credential_type = 'WEBAUTHN'
           AND status = 'ACTIVE'
           AND disabled_at IS NULL
           AND webauthn_credential_id = $1
         LIMIT 1`,
        [input.response.id],
      );
      const found = credLookup.rows[0]?.admin_user_id;
      if (found === undefined) {
        throw new AuthDomainError('UNAUTHENTICATED', 'invalid credentials');
      }
      adminUserId = found;
    }

    const owner = await requireActiveOwner(client, adminUserId, { forUpdate: true });
    await lockThrottleForUpdate(client, adminUserId);
    await assertNotLocked(client, adminUserId);

    try {
      await consumeChallenge(client, {
        challenge: challengeFromClient,
        purpose: input.purpose,
        adminUserId,
      });
    } catch (error) {
      await recordAuthFailure(client, adminUserId);
      if (error instanceof AuthDomainError) {
        return {
          status: 'auth_rejected' as const,
          adminUserId,
          error,
        };
      }
      throw error;
    }

    const creds = await client.query<{
      id: string;
      webauthn_credential_id: string;
      webauthn_public_key: string;
      webauthn_sign_count: string | null;
    }>(
      `SELECT id::text, webauthn_credential_id, webauthn_public_key, webauthn_sign_count::text
       FROM admin_credentials
       WHERE admin_user_id = $1::uuid
         AND credential_type = 'WEBAUTHN'
         AND status = 'ACTIVE'
         AND disabled_at IS NULL
         AND webauthn_credential_id = $2
       FOR UPDATE`,
      [adminUserId, input.response.id],
    );
    const credRow = creds.rows[0];
    if (credRow === undefined) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'invalid credentials'),
      };
    }

    const storedSignCount = BigInt(credRow.webauthn_sign_count ?? '0');
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: challengeFromClient,
        expectedOrigin: input.rp.origin,
        expectedRPID: input.rp.rpId,
        requireUserVerification: true,
        credential: {
          id: credRow.webauthn_credential_id,
          publicKey: decodePublicKeyBytes(credRow.webauthn_public_key),
          counter: Number(storedSignCount),
        },
      });
    } catch (error) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn authentication verification failed', {
          cause: error,
        }),
      };
    }

    if (!verification.verified || verification.authenticationInfo === undefined) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn authentication not verified'),
      };
    }

    const newCounter = BigInt(verification.authenticationInfo.newCounter);
    // Reject replays / non-increasing sign counts (counter may stay 0 for some authenticators
    // that do not support counters — only reject when stored > 0 and new <= stored).
    if (storedSignCount > 0n && newCounter <= storedSignCount) {
      await recordAuthFailure(client, adminUserId);
      await insertRedactedAudit(client, {
        adminUserId,
        actionType: 'owner_admin_auth.webauthn_sign_count_replay',
        resourceType: 'admin_credential',
        resourceId: credRow.id,
        reason: 'WebAuthn sign_count replay refused',
        afterSnapshot: {
          storedSignCount: storedSignCount.toString(),
          observedSignCount: newCounter.toString(),
        },
      });
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn sign count replay refused'),
      };
    }

    const updated = await client.query<{ id: string }>(
      `UPDATE admin_credentials
       SET webauthn_sign_count = $2,
           last_used_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
         AND (webauthn_sign_count IS NULL OR webauthn_sign_count < $2 OR webauthn_sign_count = 0)
       RETURNING id::text`,
      [credRow.id, newCounter.toString()],
    );
    if (updated.rows[0] === undefined && storedSignCount > 0n) {
      await recordAuthFailure(client, adminUserId);
      return {
        status: 'auth_rejected' as const,
        adminUserId,
        error: new AuthDomainError('UNAUTHENTICATED', 'WebAuthn sign count update refused'),
      };
    }
    if (updated.rows[0] === undefined && storedSignCount === 0n && newCounter === 0n) {
      await client.query(
        `UPDATE admin_credentials SET last_used_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [credRow.id],
      );
    }

    await clearAuthFailures(client, adminUserId);

    if (!input.createSession) {
      // Reauth path: refresh existing session.
      const sessionToken = input.existingSessionToken?.trim() ?? '';
      if (sessionToken === '') {
        throw new AuthDomainError('VALIDATION', 'sessionToken required for WebAuthn reauth');
      }
      const tokenHash = hashAdminSessionToken(sessionToken);
      const session = await client.query<{
        id: string;
        admin_user_id: string;
        idle_expires_at: Date;
        absolute_expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id::text, admin_user_id::text, idle_expires_at, absolute_expires_at, revoked_at
         FROM admin_sessions
         WHERE session_token_hash = $1
         FOR UPDATE
         LIMIT 1`,
        [tokenHash],
      );
      const row = session.rows[0];
      if (row === undefined || row.admin_user_id !== adminUserId) {
        throw new AuthDomainError('UNAUTHENTICATED', 'session not found');
      }
      if (row.revoked_at !== null) {
        throw new AuthDomainError('SESSION_REVOKED', 'session is revoked');
      }
      const now = Date.now();
      if (row.idle_expires_at.getTime() <= now || row.absolute_expires_at.getTime() <= now) {
        throw new AuthDomainError('SESSION_EXPIRED', 'session is expired');
      }
      const idle = new Date(now + ADMIN_SESSION_IDLE_TTL_MS);
      const reauth = await client.query<{ reauthenticated_at: Date }>(
        `UPDATE admin_sessions
         SET reauthenticated_at = now(),
             last_seen_at = now(),
             idle_expires_at = LEAST($2::timestamptz, absolute_expires_at)
         WHERE id = $1::uuid
           AND revoked_at IS NULL
         RETURNING reauthenticated_at`,
        [row.id, idle.toISOString()],
      );
      const reauthenticatedAt = reauth.rows[0]?.reauthenticated_at;
      if (reauthenticatedAt === undefined) {
        throw new AuthDomainError('SESSION_REVOKED', 'session is revoked');
      }
      await client.query(
        `UPDATE admin_users SET last_reauthenticated_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [adminUserId],
      );
      await insertRedactedAudit(client, {
        adminUserId,
        actionType: 'owner_admin_auth.reauthenticated',
        resourceType: 'admin_session',
        resourceId: row.id,
        reason: 'Owner admin session reauthenticated via WebAuthn',
        afterSnapshot: { factor: 'WEBAUTHN', database: gate.redactedTarget },
      });
      return {
        status: 'ok' as const,
        value: {
          adminUserId,
          sessionId: row.id,
          reauthenticatedAt: reauthenticatedAt.toISOString(),
        },
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
      actionType: 'owner_admin_auth.session_created',
      resourceType: 'admin_session',
      resourceId: session.id,
      reason: 'Owner admin session created via WebAuthn',
      afterSnapshot: {
        factor: 'WEBAUTHN',
        database: gate.redactedTarget,
        credentialRowId: credRow.id,
        newSignCount: Number(newCounter),
      },
    });

    const result: FinishWebAuthnAuthenticationResult = {
      adminUserId,
      email: owner.email,
      sessionId: session.id,
      idleExpiresAt: idle.toISOString(),
      absoluteExpiresAt: absolute.toISOString(),
      reauthenticatedAt: session.reauthenticated_at.toISOString(),
      credentialRowId: credRow.id,
      newSignCount: Number(newCounter),
    };
    return { status: 'ok' as const, value: createSessionTokenBundle(result, sessionToken) };
  });
}

export async function finishWebAuthnAuthentication(
  db: Db,
  input: {
    readonly adminUserId?: string | null;
    readonly email?: string | null;
    readonly response: AuthenticationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<FinishWebAuthnAuthenticationBundle> {
  const out = await finishWebAuthnAssertion(db, {
    ...input,
    purpose: 'AUTHENTICATION',
    createSession: true,
  });
  if (!('takeSessionTokenOnce' in out)) {
    throw new AuthDomainError('INTERNAL', 'WebAuthn login did not return a session token bundle');
  }
  return out;
}

export async function finishWebAuthnReauth(
  db: Db,
  input: {
    readonly adminUserId: string;
    readonly sessionToken: string;
    readonly response: AuthenticationResponseJSON;
    readonly rp: AdminWebAuthnRpConfig;
  } & GateFields,
): Promise<{ readonly adminUserId: string; readonly sessionId: string; readonly reauthenticatedAt: string }> {
  const out = await finishWebAuthnAssertion(db, {
    ...input,
    purpose: 'REAUTH',
    createSession: false,
    existingSessionToken: input.sessionToken,
  });
  if ('takeSessionTokenOnce' in out) {
    throw new AuthDomainError('INTERNAL', 'WebAuthn reauth unexpectedly created a session');
  }
  return out;
}

/** Test/helper: peek unconsumed challenge (does not consume). */
export async function peekWebAuthnChallengeForTests(
  db: Db,
  challengeId: string,
): Promise<{ challenge: string; purpose: string; consumedAt: Date | null } | null> {
  const pool = requireOwnerAuthPool(db);
  return withPoolOwnedReadOnlyTransaction(pool, async (client) => {
    const result = await client.query<{
      challenge: string;
      purpose: string;
      consumed_at: Date | null;
    }>(
      `SELECT challenge, purpose, consumed_at FROM admin_webauthn_challenges WHERE id = $1::uuid`,
      [challengeId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { challenge: row.challenge, purpose: row.purpose, consumedAt: row.consumed_at };
  });
}
