/**
 * Phase 21 Owner ceremony authentication (password + TOTP on live Owner TTY).
 *
 * Authority is the singleton admin_owner_authority seat + live factor verification.
 * PHASE21_CEREMONY_ADMIN_USER_ID is a locator only — never sole authority.
 *
 * Auth anti-replay / throttle may mutate auth tables; that is distinct from Phase21
 * business mutation (flag baseline / registry / hot-wallet register).
 */
import type { Pool, PoolClient } from 'pg';

import {
  assertInteractiveSecretTerminals,
  isPool,
  readSecretFromTty,
  verifyOwnerAdminPasswordAndTotp,
} from '@alex-rewards/auth';

import type { Phase21CeremonyOwnerAdminClient } from './phase21-ceremony-owner-admin.js';
import type { AuthenticatedPhase21OwnerCeremonyTrust } from './phase21-owner-ceremony-trust.js';
import { Phase21OwnerCeremonyTrustError } from './phase21-owner-ceremony-trust.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrust } from './phase21-owner-ceremony-trust-mint-internal.js';

export class Phase21OwnerCeremonyAuthError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21OwnerCeremonyAuthError';
    this.code = code;
    this.details = details;
  }
}

export interface Phase21OwnerCeremonyAuthClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

function testHooksEnabled(): boolean {
  return process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS === '1';
}

/**
 * Resolve canonical Owner seat holder (seat=1) with ACTIVE admin + ACTIVE OWNER binding.
 * Optional expectedAdminUserId (from PHASE21_CEREMONY_ADMIN_USER_ID locator) must match.
 */
export async function resolveCanonicalPhase21OwnerSeat(
  client: Phase21OwnerCeremonyAuthClient | Phase21CeremonyOwnerAdminClient,
  expectedAdminUserId?: string | null,
): Promise<{ adminUserId: string }> {
  const seat = await client.query<{ holder: string | null }>(
    `SELECT holder_admin_user_id::text AS holder
     FROM admin_owner_authority
     WHERE seat = 1
     LIMIT 1`,
  );
  const holder = seat.rows[0]?.holder ?? null;
  if (holder === null || holder.trim() === '') {
    throw new Phase21OwnerCeremonyAuthError(
      'OWNER_SEAT_VACANT',
      'admin_owner_authority seat=1 has no holder; Owner bootstrap incomplete',
      {},
    );
  }

  const admin = await client.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status
     FROM admin_users
     WHERE id = $1::uuid
     LIMIT 1`,
    [holder],
  );
  const row = admin.rows[0];
  if (row === undefined || row.status !== 'ACTIVE') {
    throw new Phase21OwnerCeremonyAuthError(
      'OWNER_SEAT_HOLDER_NOT_ACTIVE',
      'canonical Owner seat holder is missing or inactive',
      { adminUserId: holder },
    );
  }

  const binding = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [holder],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) {
    throw new Phase21OwnerCeremonyAuthError(
      'OWNER_BINDING_MISSING',
      'canonical Owner seat holder lacks ACTIVE unrevoked OWNER role binding',
      { adminUserId: holder },
    );
  }

  if (
    expectedAdminUserId !== undefined &&
    expectedAdminUserId !== null &&
    expectedAdminUserId.trim() !== ''
  ) {
    const expected = expectedAdminUserId.trim();
    if (expected.toUpperCase() === 'SYSTEM' || expected.toUpperCase() === 'NULL') {
      throw new Phase21OwnerCeremonyAuthError(
        'OWNER_ADMIN_SYSTEM_FORBIDDEN',
        'SYSTEM actor is forbidden for Phase 21 Owner ceremony',
        {},
      );
    }
    if (expected !== row.id) {
      throw new Phase21OwnerCeremonyAuthError(
        'OWNER_SEAT_LOCATOR_MISMATCH',
        'PHASE21_CEREMONY_ADMIN_USER_ID locator does not match canonical Owner seat holder',
        { expected, seatHolder: row.id },
      );
    }
  }

  return { adminUserId: row.id };
}

export interface AuthenticatePhase21OwnerCeremonyFromOwnerTtyInput {
  /** Must be a pg Pool — auth anti-replay mutates auth-state (not Phase21 business mutation). */
  readonly pool: Pool;
  readonly expectedDatabase: string;
  readonly expectedClusterSystemIdentifier: string;
  /**
   * Optional locator from PHASE21_CEREMONY_ADMIN_USER_ID only.
   * Env UUID alone is NOT authority; must match seat holder when provided.
   */
  readonly expectedAdminUserId?: string | null;
  /**
   * Test injection only (ALEX_PHASE21_CEREMONY_TEST_HOOKS=1).
   * Production must never supply password/totp via argv/env.
   */
  readonly injectedSecrets?: {
    readonly password: string;
    readonly totpCode: string;
  };
}

/**
 * Authenticate Owner on interactive TTY (password + TOTP) and mint branded ceremony trust.
 */
export async function authenticatePhase21OwnerCeremonyFromOwnerTty(
  input: AuthenticatePhase21OwnerCeremonyFromOwnerTtyInput,
): Promise<AuthenticatedPhase21OwnerCeremonyTrust> {
  if (!isPool(input.pool)) {
    throw new Phase21OwnerCeremonyAuthError(
      'OWNER_AUTH_POOL_REQUIRED',
      'authenticatePhase21OwnerCeremonyFromOwnerTty requires a writable pg Pool (auth anti-replay)',
      {},
    );
  }

  const hooks = testHooksEnabled();
  const useInjected = input.injectedSecrets !== undefined;
  if (useInjected && !hooks) {
    throw new Phase21OwnerCeremonyAuthError(
      'TEST_HOOKS_REQUIRED',
      'injected secrets require ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  if (!useInjected) {
    try {
      assertInteractiveSecretTerminals();
    } catch (error: unknown) {
      throw new Phase21OwnerCeremonyAuthError(
        'INTERACTIVE_TTY_REQUIRED',
        error instanceof Error ? error.message : 'interactive TTY required for Owner ceremony auth',
        {},
      );
    }
  }

  const client: PoolClient = await input.pool.connect();
  let adminUserId: string;
  try {
    const seat = await resolveCanonicalPhase21OwnerSeat(client, input.expectedAdminUserId);
    adminUserId = seat.adminUserId;
  } finally {
    client.release();
  }

  let password = '';
  let totpCode = '';
  try {
    if (useInjected && input.injectedSecrets !== undefined) {
      password = input.injectedSecrets.password;
      totpCode = input.injectedSecrets.totpCode;
    } else {
      password = await readSecretFromTty('Owner admin password (TTY, not echoed): ');
      totpCode = await readSecretFromTty('Owner TOTP code (TTY, not echoed): ');
    }

    await verifyOwnerAdminPasswordAndTotp(input.pool, {
      adminUserId,
      password,
      totpCode,
      expectedDatabase: input.expectedDatabase,
      expectedClusterSystemIdentifier: input.expectedClusterSystemIdentifier,
    });

    return mintAuthenticatedPhase21OwnerCeremonyTrust({
      adminUserId,
      currentDatabase: input.expectedDatabase,
      systemIdentifier: input.expectedClusterSystemIdentifier,
    });
  } finally {
    password = '';
    totpCode = '';
  }
}

export { Phase21OwnerCeremonyTrustError };
