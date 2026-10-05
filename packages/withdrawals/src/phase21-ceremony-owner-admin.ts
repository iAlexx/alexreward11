/**
 * Resolve ACTIVE admin_users + ACTIVE unrevoked OWNER role binding.
 *
 * This is a locator / binding check only — NOT authentication and NOT APPLY authority.
 * APPLY must use branded AuthenticatedPhase21OwnerCeremonyTrust from Owner TTY auth.
 * Prefer resolveCanonicalPhase21OwnerSeat + authenticatePhase21OwnerCeremonyFromOwnerTty.
 * SYSTEM / null actors are refused.
 */
export class Phase21CeremonyOwnerAdminError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21CeremonyOwnerAdminError';
    this.code = code;
    this.details = details;
  }
}

export interface Phase21CeremonyOwnerAdminClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Align with ledger Phase21 provision UUID acceptance (v1-v8). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): string {
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new Phase21CeremonyOwnerAdminError(
      'OWNER_ADMIN_ID_INVALID',
      `${field} must be a UUID`,
      { field },
    );
  }
  return trimmed;
}

/**
 * Locator/binding check only. Env UUID alone is NOT APPLY authority.
 * Prefer branded Owner ceremony trust on APPLY paths.
 */
export async function resolvePhase21CeremonyOwnerAdmin(
  client: Phase21CeremonyOwnerAdminClient,
  adminUserId: string | null | undefined,
): Promise<{ adminUserId: string }> {
  if (adminUserId === null || adminUserId === undefined || adminUserId.trim() === '') {
    throw new Phase21CeremonyOwnerAdminError(
      'OWNER_ADMIN_REQUIRED',
      'PHASE21_CEREMONY_ADMIN_USER_ID required (SYSTEM/null actor forbidden for production ceremony)',
      {},
    );
  }
  const normalized = adminUserId.trim().toUpperCase();
  if (normalized === 'SYSTEM' || normalized === 'NULL') {
    throw new Phase21CeremonyOwnerAdminError(
      'OWNER_ADMIN_SYSTEM_FORBIDDEN',
      'SYSTEM actor is forbidden for Phase 21 production ceremony APPLY',
      {},
    );
  }

  const adminId = assertUuid(adminUserId, 'adminUserId');
  const admin = await client.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status
     FROM admin_users
     WHERE id = $1::uuid
     LIMIT 1`,
    [adminId],
  );
  const row = admin.rows[0];
  if (row === undefined || row.status !== 'ACTIVE') {
    throw new Phase21CeremonyOwnerAdminError(
      'OWNER_ADMIN_NOT_ACTIVE',
      'configured Owner admin is missing or inactive',
      { adminUserId: adminId },
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
    [adminId],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) {
    throw new Phase21CeremonyOwnerAdminError(
      'OWNER_BINDING_MISSING',
      'configured Owner admin lacks ACTIVE OWNER role binding',
      { adminUserId: adminId },
    );
  }

  return { adminUserId: row.id };
}
