/**
 * CLAIM_EXISTING_ADMIN eligibility + binding helpers (Phase 21 Step 4A).
 * Existing admin UUID/email is a locator only — never Owner authority by itself.
 */
import type { PoolClient } from 'pg';

import { AuthDomainError } from '../errors.js';

export type ExistingAdminCredentialState =
  | 'CLEAN_FIRST_OWNER_CLAIM_ELIGIBLE'
  | 'EXISTING_ADMIN_CREDENTIAL_STATE_REQUIRES_OWNER_REVIEW'
  | 'INELIGIBLE';

export interface ClaimExistingAdminPreflightResult {
  readonly eligible: boolean;
  readonly refuseCode: string | null;
  readonly targetAdminUserId: string | null;
  readonly targetAdminStatus: string | null;
  readonly targetAdminEmail: string | null;
  readonly activeOwnerBindingCount: number;
  readonly ownerBindingHistoryCount: number;
  readonly seatHolderAdminUserId: string | null;
  readonly ownerRoleStatus: string | null;
  readonly credentialState: ExistingAdminCredentialState;
  readonly passwordCredentialCount: number;
  readonly totpCredentialCount: number;
  readonly activeSessionCount: number;
  readonly notes: readonly string[];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Read-only eligibility inspection for CLAIM_EXISTING_ADMIN.
 * Does not establish Owner authority — only checks whether claim may proceed
 * after cryptographic ceremony succeeds.
 */
export async function preflightClaimExistingAdmin(
  client: PoolClient,
  input: {
    readonly intendedAdminUserId: string;
    readonly intendedAdminEmail: string;
  },
): Promise<ClaimExistingAdminPreflightResult> {
  const intendedId = input.intendedAdminUserId.trim();
  const intendedEmail = normalizeEmail(input.intendedAdminEmail);

  const notes: string[] = [];
  const empty = (
    refuseCode: string,
    partial: Partial<ClaimExistingAdminPreflightResult> = {},
  ): ClaimExistingAdminPreflightResult => ({
    eligible: false,
    refuseCode,
    targetAdminUserId: partial.targetAdminUserId ?? null,
    targetAdminStatus: partial.targetAdminStatus ?? null,
    targetAdminEmail: partial.targetAdminEmail ?? null,
    activeOwnerBindingCount: partial.activeOwnerBindingCount ?? 0,
    ownerBindingHistoryCount: partial.ownerBindingHistoryCount ?? 0,
    seatHolderAdminUserId: partial.seatHolderAdminUserId ?? null,
    ownerRoleStatus: partial.ownerRoleStatus ?? null,
    credentialState: partial.credentialState ?? 'INELIGIBLE',
    passwordCredentialCount: partial.passwordCredentialCount ?? 0,
    totpCredentialCount: partial.totpCredentialCount ?? 0,
    activeSessionCount: partial.activeSessionCount ?? 0,
    notes: [...notes, ...(partial.notes ?? [])],
  });

  const role = await client.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status::text AS status FROM admin_roles WHERE code = 'OWNER' LIMIT 1`,
  );
  const ownerRole = role.rows[0];
  if (ownerRole === undefined) {
    return empty('OWNER_ROLE_MISSING');
  }
  if (ownerRole.status !== 'ACTIVE') {
    return empty('OWNER_ROLE_NOT_ACTIVE', { ownerRoleStatus: ownerRole.status });
  }

  const seat = await client.query<{ holder: string | null }>(
    `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
  );
  const seatHolder = seat.rows[0]?.holder ?? null;
  if (seatHolder !== null) {
    return empty('OWNER_SEAT_ALREADY_HELD', {
      seatHolderAdminUserId: seatHolder,
      ownerRoleStatus: ownerRole.status,
    });
  }

  const history = await client.query<{ c: number }>(
    `SELECT count(DISTINCT b.admin_user_id)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER'`,
  );
  const ownerBindingHistoryCount = history.rows[0]?.c ?? 0;
  if (ownerBindingHistoryCount > 0) {
    return empty('OWNER_BINDING_HISTORY_EXISTS', {
      ownerBindingHistoryCount,
      ownerRoleStatus: ownerRole.status,
      seatHolderAdminUserId: null,
    });
  }

  const active = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
  );
  const activeOwnerBindingCount = active.rows[0]?.c ?? 0;
  if (activeOwnerBindingCount > 0) {
    return empty('ACTIVE_OWNER_BINDING_PRESENT', {
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
      ownerRoleStatus: ownerRole.status,
    });
  }

  const byId = await client.query<{ id: string; email: string; status: string }>(
    `SELECT id::text AS id, email, status::text AS status
     FROM admin_users WHERE id = $1::uuid`,
    [intendedId],
  );
  const row = byId.rows[0];
  if (row === undefined) {
    return empty('TARGET_ADMIN_NOT_FOUND', {
      ownerRoleStatus: ownerRole.status,
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
    });
  }
  if (row.status !== 'ACTIVE') {
    return empty('TARGET_ADMIN_NOT_ACTIVE', {
      targetAdminUserId: row.id,
      targetAdminStatus: row.status,
      targetAdminEmail: row.email,
      ownerRoleStatus: ownerRole.status,
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
    });
  }
  if (normalizeEmail(row.email) !== intendedEmail) {
    return empty('TARGET_ADMIN_EMAIL_MISMATCH', {
      targetAdminUserId: row.id,
      targetAdminStatus: row.status,
      targetAdminEmail: row.email,
      ownerRoleStatus: ownerRole.status,
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
      notes: ['grant intended email must equal existing admin_users.email'],
    });
  }

  const emailMatches = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM admin_users
     WHERE lower(trim(email)) = $1 AND status = 'ACTIVE'`,
    [intendedEmail],
  );
  if ((emailMatches.rows[0]?.c ?? 0) !== 1) {
    return empty('TARGET_ADMIN_AMBIGUOUS', {
      targetAdminUserId: row.id,
      targetAdminStatus: row.status,
      targetAdminEmail: row.email,
      ownerRoleStatus: ownerRole.status,
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
    });
  }

  const creds = await client.query<{ credential_type: string; status: string; c: number }>(
    `SELECT credential_type::text AS credential_type, status::text AS status, count(*)::int AS c
     FROM admin_credentials
     WHERE admin_user_id = $1::uuid
     GROUP BY credential_type, status`,
    [row.id],
  );
  let passwordCredentialCount = 0;
  let totpCredentialCount = 0;
  for (const c of creds.rows) {
    if (c.credential_type === 'PASSWORD' && c.status === 'ACTIVE') passwordCredentialCount += c.c;
    if (c.credential_type === 'TOTP' && c.status === 'ACTIVE') totpCredentialCount += c.c;
  }
  if (passwordCredentialCount > 0 || totpCredentialCount > 0) {
    return empty('EXISTING_ADMIN_CREDENTIAL_STATE_REQUIRES_OWNER_REVIEW', {
      targetAdminUserId: row.id,
      targetAdminStatus: row.status,
      targetAdminEmail: row.email,
      ownerRoleStatus: ownerRole.status,
      activeOwnerBindingCount,
      ownerBindingHistoryCount,
      passwordCredentialCount,
      totpCredentialCount,
      credentialState: 'EXISTING_ADMIN_CREDENTIAL_STATE_REQUIRES_OWNER_REVIEW',
    });
  }

  let activeSessionCount = 0;
  try {
    const sessions = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_sessions
       WHERE admin_user_id = $1::uuid
         AND (revoked_at IS NULL OR expires_at > now())`,
      [row.id],
    );
    activeSessionCount = sessions.rows[0]?.c ?? 0;
  } catch {
    // Schema variance — treat as unknown/zero for eligibility; credentials remain authoritative.
    activeSessionCount = 0;
    notes.push('admin_sessions_count_unavailable');
  }

  notes.push('locator_only_not_authority');
  notes.push('cryptographic_ceremony_still_required');
  return {
    eligible: true,
    refuseCode: null,
    targetAdminUserId: row.id,
    targetAdminStatus: row.status,
    targetAdminEmail: row.email,
    activeOwnerBindingCount,
    ownerBindingHistoryCount,
    seatHolderAdminUserId: null,
    ownerRoleStatus: ownerRole.status,
    credentialState: 'CLEAN_FIRST_OWNER_CLAIM_ELIGIBLE',
    passwordCredentialCount,
    totpCredentialCount,
    activeSessionCount,
    notes,
  };
}

export function assertClaimExistingAdminEligible(
  result: ClaimExistingAdminPreflightResult,
): void {
  if (!result.eligible || result.refuseCode !== null) {
    throw new AuthDomainError(
      'FORBIDDEN',
      result.refuseCode ?? 'CLAIM_EXISTING_ADMIN_INELIGIBLE',
    );
  }
}