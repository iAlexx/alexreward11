/**
 * Phase 21 Step 4B.1 - hydrate intended-existing-admin.json from the live admin row.
 * Read-only (BEGIN READ ONLY + ROLLBACK). The binding is a locator, never authority.
 * Never returns or logs the full email.
 */
import { AuthDomainError } from '../errors.js';
import { createBootstrapTrustMaterial, type OwnerBootstrapPool } from './pool.js';
import {
  loadIntendedExistingAdminBinding,
  loadProductionCeremonyBundle,
  writeIntendedExistingAdminBinding,
} from './production-ceremony-gate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function maskEmailForOutput(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.length <= 1 ? '*' : `${local[0]}***`}@${domain}`;
}

export interface HydrateIntendedExistingAdminResult {
  readonly adminUserId: string;
  readonly adminStatus: 'ACTIVE';
  readonly emailMasked: string;
  readonly bindingWritten: true;
  /** null when no bundle file exists yet; false means seal/bundle must be re-drafted. */
  readonly bundleMatchesBinding: boolean | null;
}

export async function hydrateIntendedExistingAdminBindingFromDatabase(input: {
  readonly ceremonyDir: string;
  readonly bootstrap: OwnerBootstrapPool;
  /** Defaults to the id in the existing binding file. */
  readonly intendedAdminUserId?: string;
}): Promise<HydrateIntendedExistingAdminResult> {
  // Throws unless the pool is a registered verified bootstrap pool.
  createBootstrapTrustMaterial(input.bootstrap, new Map());
  if (input.bootstrap.profile.deploymentEnv !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'hydrate requires a production-profile verified pool');
  }

  let adminId = input.intendedAdminUserId?.trim() ?? '';
  if (adminId === '') {
    adminId = loadIntendedExistingAdminBinding(input.ceremonyDir).intended_admin_user_id.trim();
  }
  if (!UUID_RE.test(adminId)) {
    throw new AuthDomainError('VALIDATION', 'intended admin id must be a UUID');
  }

  const client = await input.bootstrap.pool.connect();
  let row: { id: string; email: string; status: string } | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const ro = await client.query<{ transaction_read_only: string }>(`SHOW transaction_read_only`);
      if (ro.rows[0]?.transaction_read_only !== 'on') {
        throw new AuthDomainError('FORBIDDEN', 'transaction_read_only is not on - refuse');
      }
      const res = await client.query<{ id: string; email: string; status: string }>(
        `SELECT id::text AS id, email, status::text AS status
         FROM admin_users WHERE id = $1::uuid`,
        [adminId],
      );
      row = res.rows[0];
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }

  if (row === undefined) {
    throw new AuthDomainError('FORBIDDEN', 'TARGET_ADMIN_NOT_FOUND');
  }
  if (row.status !== 'ACTIVE') {
    throw new AuthDomainError('FORBIDDEN', 'TARGET_ADMIN_NOT_ACTIVE');
  }
  const canonicalEmail = row.email.trim().toLowerCase();
  if (canonicalEmail === '' || !canonicalEmail.includes('@')) {
    throw new AuthDomainError('FORBIDDEN', 'TARGET_ADMIN_EMAIL_INVALID');
  }

  writeIntendedExistingAdminBinding(input.ceremonyDir, {
    enrollment_mode: 'CLAIM_EXISTING_ADMIN',
    intended_admin_user_id: row.id,
    intended_admin_email: canonicalEmail,
    note: 'locator_only_not_authority',
  });

  let bundleMatchesBinding: boolean | null = null;
  try {
    const bundle = loadProductionCeremonyBundle(input.ceremonyDir);
    bundleMatchesBinding =
      bundle.intended_admin_user_id === row.id &&
      bundle.intended_admin_email.trim().toLowerCase() === canonicalEmail;
  } catch {
    // no readable bundle yet - leave null
  }

  return {
    adminUserId: row.id,
    adminStatus: 'ACTIVE',
    emailMasked: maskEmailForOutput(canonicalEmail),
    bindingWritten: true,
    bundleMatchesBinding,
  };
}
