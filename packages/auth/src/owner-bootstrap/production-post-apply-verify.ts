/**
 * Phase 21 Step 4B.2 - read-only verification of a completed production Owner bootstrap.
 * BEGIN READ ONLY + ROLLBACK only. Returns sanitized facts (no email, no secrets, no hashes).
 */
import type { Pool } from 'pg';

import { AuthDomainError } from '../errors.js';

export interface ProductionPostApplyVerifyInput {
  readonly adminUserId: string;
  readonly grantId: string;
  readonly attemptId: string;
}

export interface ProductionPostApplyVerifyResult {
  readonly ok: boolean;
  readonly operationalDbMutation: false;
  readonly readOnlyTransaction: boolean;
  readonly adminStatus: string | null;
  readonly ownerSeatHolderMatches: boolean;
  readonly activeOwnerBindingCount: number;
  readonly activePasswordCredentialCount: number;
  readonly activeTotpCredentialCount: number;
  readonly grantStatus: string | null;
  readonly attemptStatus: string | null;
  readonly enrollmentAuditRecordCount: number;
  readonly failures: readonly string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new AuthDomainError('VALIDATION', `${name} must be a UUID`);
  }
}

export async function verifyProductionOwnerBootstrapApplyReadOnly(
  pool: Pool,
  input: ProductionPostApplyVerifyInput,
): Promise<ProductionPostApplyVerifyResult> {
  assertUuid('adminUserId', input.adminUserId);
  assertUuid('grantId', input.grantId);
  assertUuid('attemptId', input.attemptId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const ro = await client.query<{ transaction_read_only: string }>(
        `SHOW transaction_read_only`,
      );
      if (ro.rows[0]?.transaction_read_only !== 'on') {
        throw new AuthDomainError('FORBIDDEN', 'transaction_read_only is not on - refuse');
      }

      const admin = await client.query<{ status: string }>(
        `SELECT status::text AS status FROM admin_users WHERE id = $1::uuid`,
        [input.adminUserId],
      );
      const seat = await client.query<{ holder: string | null }>(
        `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
      );
      const bindings = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM admin_role_bindings b
           JOIN admin_roles r ON r.id = b.role_id
          WHERE b.admin_user_id = $1::uuid AND b.revoked_at IS NULL AND r.code = 'OWNER'`,
        [input.adminUserId],
      );
      const creds = await client.query<{ t: string; c: number }>(
        `SELECT credential_type::text AS t, count(*)::int AS c
           FROM admin_credentials
          WHERE admin_user_id = $1::uuid AND status = 'ACTIVE'
          GROUP BY credential_type`,
        [input.adminUserId],
      );
      const grant = await client.query<{ s: string }>(
        `SELECT status::text AS s FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
        [input.grantId],
      );
      const attempt = await client.query<{ s: string }>(
        `SELECT pop_status::text AS s FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [input.attemptId],
      );
      const audit = await client.query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM audit_logs
          WHERE action_type = 'OWNER_BOOTSTRAP_ENROLL'
            AND resource_id::text = $1
            AND after_snapshot->>'grant_id' = $2
            AND after_snapshot->>'attempt_id' = $3`,
        [input.adminUserId, input.grantId, input.attemptId],
      );

      const credCount = (type: string): number =>
        Number(creds.rows.find((r) => r.t === type)?.c ?? 0);
      const adminStatus = admin.rows[0]?.status ?? null;
      const ownerSeatHolderMatches = seat.rows[0]?.holder === input.adminUserId;
      const activeOwnerBindingCount = Number(bindings.rows[0]?.c ?? 0);
      const activePasswordCredentialCount = credCount('PASSWORD');
      const activeTotpCredentialCount = credCount('TOTP');
      const grantStatus = grant.rows[0]?.s ?? null;
      const attemptStatus = attempt.rows[0]?.s ?? null;
      const enrollmentAuditRecordCount = Number(audit.rows[0]?.c ?? 0);

      const failures: string[] = [];
      if (adminStatus !== 'ACTIVE') failures.push('ADMIN_NOT_ACTIVE');
      if (!ownerSeatHolderMatches) failures.push('OWNER_SEAT_HOLDER_MISMATCH');
      if (activeOwnerBindingCount !== 1) failures.push('OWNER_BINDING_COUNT_NOT_1');
      if (activePasswordCredentialCount !== 1) failures.push('PASSWORD_CREDENTIAL_COUNT_NOT_1');
      if (activeTotpCredentialCount !== 1) failures.push('TOTP_CREDENTIAL_COUNT_NOT_1');
      if (grantStatus !== 'CONSUMED') failures.push('GRANT_NOT_CONSUMED');
      if (attemptStatus !== 'CONSUMED') failures.push('ATTEMPT_NOT_CONSUMED');
      if (enrollmentAuditRecordCount < 1) failures.push('ENROLLMENT_AUDIT_MISSING');

      return {
        ok: failures.length === 0,
        operationalDbMutation: false,
        readOnlyTransaction: true,
        adminStatus,
        ownerSeatHolderMatches,
        activeOwnerBindingCount,
        activePasswordCredentialCount,
        activeTotpCredentialCount,
        grantStatus,
        attemptStatus,
        enrollmentAuditRecordCount,
        failures,
      };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
