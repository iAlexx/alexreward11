/**
 * Phase 21 Step 4B — read-only production Owner-bootstrap preflight.
 * Never INSERT/UPDATE/DELETE. Never consumes grants or creates credentials.
 */
import { isIP } from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { Pool, type PoolClient } from 'pg';

import { AuthDomainError } from '../errors.js';
import { buildVerifyFullTlsSocketOptions } from './tls-verify-full.js';
import { preflightProductionOwnerBootstrapSchema } from './production-schema-preflight.js';
import {
  inspectExistingAdminAuthMaterial,
  preflightClaimExistingAdmin,
  type ClaimExistingAdminAuthCounts,
} from './claim-existing-admin.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

const TARGET_ADMIN_CANDIDATE_ID = 'a11a11a1-0000-4000-8000-000000000011';

export interface ProductionTrustedEndpointDiscoveryInput {
  readonly proxyHostname: string;
  readonly proxyPort: number;
  readonly databaseName: string;
  readonly user: string;
  readonly password: string;
  readonly caPem: string;
  readonly tlsServerName: string;
  /** When set, must match live pg_control_system().system_identifier. */
  readonly expectedSystemIdentifier?: string;
}

export interface ProductionTrustedEndpointDiscoveryResult {
  readonly dialIp: string;
  readonly dialPort: number;
  readonly tlsServerName: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly sslInUse: true;
  readonly tlsVerifyFull: true;
}

export interface ProductionOwnerBootstrapPreflightOnlyResult {
  readonly trustClass: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly mode: 'preflight-only';
  readonly operationalDbMutation: false;
  readonly trustAuthenticated: boolean;
  readonly tlsEndpointVerified: boolean;
  readonly schemaReady: boolean;
  readonly ownerSeatReady: boolean;
  readonly targetAdminReady: boolean;
  readonly targetAdminSecurityState: 'CLEAN' | 'REQUIRES_OWNER_REVIEW' | 'UNKNOWN' | 'NOT_FOUND';
  readonly ownerKeyBackupsReady: boolean;
  readonly readyForOwnerBootstrapApply: boolean;
  readonly refuseCode: string | null;
  readonly dialIp: string | null;
  readonly tlsServerName: string | null;
  readonly operationalDatabaseName: string | null;
  readonly operationalSystemIdentifier: string | null;
  readonly requiredMigrationsPresent: readonly string[];
  readonly requiredMigrationsMissing: readonly string[];
  readonly ownerSeatStatus: string | null;
  readonly ownerBindingHistoryCount: number | null;
  readonly activeOwnerBindingCount: number | null;
  readonly ownerRoleStatus: string | null;
  readonly targetExistingAdminId: string | null;
  readonly targetExistingAdminStatus: string | null;
  readonly authCounts: ClaimExistingAdminAuthCounts | null;
  /** Populated only by the authenticated read-only preflight (branded trust). */
  readonly authenticatedBundleDigestHex: string | null;
  readonly authenticatedKeyId: string | null;
  readonly authenticatedEndpointProfileId: string | null;
  readonly notes: readonly string[];
}

function isNumericLoopback(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\/\d+$/, '');
  if (h === '127.0.0.1' || h === '::1') return true;
  const version = isIP(h);
  if (version === 4) return h.startsWith('127.');
  if (version === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

function isPrivateOrLoopbackOrLinkLocal(addr: string): boolean {
  const h = addr.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\/\d+$/, '');
  if (h === '') return true;
  if (isNumericLoopback(h)) return true;
  const version = isIP(h);
  if (version === 4) {
    if (h.startsWith('10.')) return true;
    if (h.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    if (h.startsWith('169.254.')) return true;
    return false;
  }
  if (version === 6) {
    if (h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
    return false;
  }
  return true;
}

/** Resolve TCP proxy hostname to public numeric IPv4 dial targets (rejects private). */
export async function resolvePublicProxyDialIps(proxyHostname: string): Promise<readonly string[]> {
  const host = proxyHostname.trim().toLowerCase();
  if (host === '') {
    throw new AuthDomainError('VALIDATION', 'proxy hostname empty');
  }
  if (isIP(host) !== 0) {
    if (isPrivateOrLoopbackOrLinkLocal(host)) {
      throw new AuthDomainError('FORBIDDEN', 'proxy dial IP is private/loopback/link-local');
    }
    return [host];
  }
  const ips = await resolve4(host);
  const publicIps = ips.filter((ip) => !isPrivateOrLoopbackOrLinkLocal(ip));
  if (publicIps.length === 0) {
    throw new AuthDomainError('FORBIDDEN', 'no public IPv4 for TCP proxy hostname');
  }
  return publicIps;
}

/**
 * Open a one-shot verify-full connection using numeric dial IP + independent tls_server_name.
 * Discover (or verify) system_identifier. Read-only.
 */
export async function discoverProductionTrustedEndpoint(
  input: ProductionTrustedEndpointDiscoveryInput,
): Promise<ProductionTrustedEndpointDiscoveryResult> {
  if (process.env.OWNER_PRODUCTION_BOOTSTRAP_APPLY === '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'OWNER_PRODUCTION_BOOTSTRAP_APPLY is enabled — stop before DB connection in Step4B',
    );
  }
  if (input.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required');
  }
  if (input.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'CA PEM required');
  }
  const dialIps = await resolvePublicProxyDialIps(input.proxyHostname);
  let lastError: unknown;
  for (const dialIp of dialIps) {
    const ssl = buildVerifyFullTlsSocketOptions({
      caPem: input.caPem,
      tlsServerName: input.tlsServerName,
    });
    const pool = new Pool({
      host: dialIp,
      port: input.proxyPort,
      database: input.databaseName,
      user: input.user,
      password: input.password,
      max: 1,
      connectionTimeoutMillis: 20_000,
      application_name: 'alex-owner-production-bootstrap-preflight-ro',
      ssl,
    });
    try {
      const client = await pool.connect();
      try {
        const dbRes = await client.query<{ current_database: string }>(`SELECT current_database()`);
        const databaseName = dbRes.rows[0]?.current_database ?? '';
        if (databaseName !== input.databaseName) {
          throw new AuthDomainError('FORBIDDEN', 'current_database mismatch');
        }
        const sslRes = await client.query<{ ssl: boolean | null }>(
          `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
        );
        if (sslRes.rows[0]?.ssl !== true) {
          throw new AuthDomainError('FORBIDDEN', 'pg_stat_ssl.ssl != true');
        }
        const sidRes = await client.query<{ system_identifier: string }>(
          `SELECT system_identifier::text AS system_identifier FROM pg_control_system()`,
        );
        const systemIdentifier = sidRes.rows[0]?.system_identifier ?? '';
        if (systemIdentifier === '') {
          throw new AuthDomainError('FORBIDDEN', 'system_identifier unavailable');
        }
        if (
          input.expectedSystemIdentifier !== undefined &&
          input.expectedSystemIdentifier !== '' &&
          input.expectedSystemIdentifier !== systemIdentifier
        ) {
          throw new AuthDomainError('FORBIDDEN', 'system_identifier mismatch');
        }
        return {
          dialIp,
          dialPort: input.proxyPort,
          tlsServerName: input.tlsServerName,
          databaseName,
          systemIdentifier,
          sslInUse: true,
          tlsVerifyFull: true,
        };
      } finally {
        client.release();
      }
    } catch (error) {
      lastError = error;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AuthDomainError('FORBIDDEN', 'verify-full trusted endpoint discovery failed');
}

async function withReadOnlyClient<T>(
  input: ProductionTrustedEndpointDiscoveryInput & { readonly dialIp: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ssl = buildVerifyFullTlsSocketOptions({
    caPem: input.caPem,
    tlsServerName: input.tlsServerName,
  });
  const pool = new Pool({
    host: input.dialIp,
    port: input.proxyPort,
    database: input.databaseName,
    user: input.user,
    password: input.password,
    max: 1,
    connectionTimeoutMillis: 20_000,
    application_name: 'alex-owner-production-bootstrap-preflight-ro',
    ssl,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      try {
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export interface ProductionOwnerBootstrapReadOnlyEvaluationInput {
  readonly intendedAdminUserId: string;
  /** null => use the email stored on the admin row (unauthenticated diagnostics only). */
  readonly intendedAdminEmail: string | null;
  readonly trustAuthenticated: boolean;
  readonly ownerKeyBackupsReady: boolean;
  readonly authenticatedBinding: {
    readonly bundleDigestHex: string;
    readonly keyId: string;
    readonly endpointProfileId: string;
  } | null;
  readonly endpoint: {
    readonly dialIp: string | null;
    readonly tlsServerName: string | null;
    readonly databaseName: string;
    readonly systemIdentifier: string;
  };
  readonly notes: string[];
}

/**
 * Shared read-only evaluation. MUST be called inside BEGIN READ ONLY.
 * Package-internal: not re-exported from the public index.
 */
export async function evaluateProductionOwnerBootstrapReadOnlyState(
  client: PoolClient,
  input: ProductionOwnerBootstrapReadOnlyEvaluationInput,
): Promise<ProductionOwnerBootstrapPreflightOnlyResult> {
  const notes = input.notes;
  const schema = await preflightProductionOwnerBootstrapSchema(client);

  const seat = await client.query<{
    holder: string | null;
    active_binding_id: string | null;
    claimed_at: string | null;
  }>(
    `SELECT holder_admin_user_id::text AS holder,
            active_binding_id::text AS active_binding_id,
            claimed_at::text AS claimed_at
     FROM admin_owner_authority WHERE seat = 1`,
  );
  const seatRow = seat.rows[0];
  const ownerSeatVacant =
    seatRow !== undefined &&
    seatRow.holder === null &&
    seatRow.active_binding_id === null &&
    seatRow.claimed_at === null;

  const role = await client.query<{ status: string }>(
    `SELECT status::text AS status FROM admin_roles WHERE code = 'OWNER' LIMIT 1`,
  );
  const ownerRoleStatus = role.rows[0]?.status ?? null;

  const history = await client.query<{ c: number }>(
    `SELECT count(DISTINCT b.admin_user_id)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER'`,
  );
  const ownerBindingHistoryCount = history.rows[0]?.c ?? 0;
  const active = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
  );
  const activeOwnerBindingCount = active.rows[0]?.c ?? 0;

  const admin = await client.query<{ id: string; email: string; status: string }>(
    `SELECT id::text AS id, email, status::text AS status
     FROM admin_users WHERE id = $1::uuid`,
    [input.intendedAdminUserId],
  );
  const adminRow = admin.rows[0];

  let targetAdminSecurityState: ProductionOwnerBootstrapPreflightOnlyResult['targetAdminSecurityState'] =
    'NOT_FOUND';
  let authCounts: ClaimExistingAdminAuthCounts | null = null;
  let targetAdminReady = false;
  let claimEligible = false;

  if (adminRow === undefined) {
    notes.push('target admin candidate not found');
  } else if (adminRow.status !== 'ACTIVE') {
    targetAdminSecurityState = 'REQUIRES_OWNER_REVIEW';
    notes.push('target admin not ACTIVE');
  } else {
    const auth = await inspectExistingAdminAuthMaterial(client, adminRow.id);
    if (!auth.ok) {
      targetAdminSecurityState = 'UNKNOWN';
      notes.push(auth.refuseCode);
    } else {
      authCounts = auth.counts;
      const dirty =
        auth.counts.activePasswordCount > 0 ||
        auth.counts.activeTotpCount > 0 ||
        auth.counts.activeWebauthnCount > 0 ||
        auth.counts.otherActiveCredentialCount > 0 ||
        auth.counts.unconsumedRecoveryCodeCount > 0 ||
        auth.counts.activeSessionCount > 0 ||
        auth.counts.openAdminActionTokenCount > 0 ||
        auth.counts.credentialRowsTotal > 0;
      targetAdminSecurityState = dirty ? 'REQUIRES_OWNER_REVIEW' : 'CLEAN';
      if (!dirty) {
        const email = (input.intendedAdminEmail ?? adminRow.email).trim();
        const claim = await preflightClaimExistingAdmin(client, {
          intendedAdminUserId: adminRow.id,
          intendedAdminEmail: email,
          lockForUpdate: false,
        });
        claimEligible = claim.eligible;
        targetAdminReady = claim.eligible;
        if (!claim.eligible) {
          notes.push(claim.refuseCode ?? 'claim preflight refused');
        }
      }
    }
  }

  const ownerSeatReady =
    ownerSeatVacant &&
    ownerBindingHistoryCount === 0 &&
    activeOwnerBindingCount === 0 &&
    ownerRoleStatus === 'ACTIVE';

  const trustAuthenticated = input.trustAuthenticated;
  const ownerKeyBackupsReady = input.ownerKeyBackupsReady;
  const readyForOwnerBootstrapApply =
    trustAuthenticated &&
    schema.schemaReady &&
    ownerSeatReady &&
    targetAdminReady &&
    targetAdminSecurityState === 'CLEAN' &&
    claimEligible &&
    ownerKeyBackupsReady;

  let refuseCode: string | null = null;
  if (!schema.schemaReady) refuseCode = schema.refuseCode ?? 'SCHEMA_NOT_READY';
  else if (!ownerSeatReady) refuseCode = 'OWNER_SEAT_NOT_READY';
  else if (targetAdminSecurityState !== 'CLEAN') {
    refuseCode =
      targetAdminSecurityState === 'UNKNOWN'
        ? 'EXISTING_ADMIN_SECURITY_STATE_UNKNOWN'
        : 'EXISTING_ADMIN_AUTH_STATE_REQUIRES_OWNER_REVIEW';
  } else if (!targetAdminReady) refuseCode = 'TARGET_ADMIN_NOT_READY';
  else if (!trustAuthenticated) refuseCode = 'TRUST_NOT_AUTHENTICATED';
  else if (!ownerKeyBackupsReady) refuseCode = 'OWNER_KEY_OFFLINE_BACKUPS_PENDING';

  return {
    trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    mode: 'preflight-only',
    operationalDbMutation: false,
    trustAuthenticated,
    tlsEndpointVerified: true,
    schemaReady: schema.schemaReady,
    ownerSeatReady,
    targetAdminReady,
    targetAdminSecurityState,
    ownerKeyBackupsReady,
    readyForOwnerBootstrapApply,
    refuseCode,
    dialIp: input.endpoint.dialIp,
    tlsServerName: input.endpoint.tlsServerName,
    operationalDatabaseName: input.endpoint.databaseName,
    operationalSystemIdentifier: input.endpoint.systemIdentifier,
    requiredMigrationsPresent: schema.appliedMigrationVersions,
    requiredMigrationsMissing: schema.missingMigrations,
    ownerSeatStatus: ownerSeatVacant ? 'VACANT' : 'HELD_OR_PARTIAL',
    ownerBindingHistoryCount,
    activeOwnerBindingCount,
    ownerRoleStatus,
    targetExistingAdminId: adminRow?.id ?? null,
    targetExistingAdminStatus: adminRow?.status ?? null,
    authCounts,
    authenticatedBundleDigestHex: input.authenticatedBinding?.bundleDigestHex ?? null,
    authenticatedKeyId: input.authenticatedBinding?.keyId ?? null,
    authenticatedEndpointProfileId: input.authenticatedBinding?.endpointProfileId ?? null,
    notes,
  };
}

/**
 * Unauthenticated read-only diagnostics. Never carries trust authority:
 * trustAuthenticated is always false and readyForOwnerBootstrapApply is always false.
 */
export async function runProductionOwnerBootstrapPreflightOnly(input: {
  readonly endpoint: ProductionTrustedEndpointDiscoveryInput;
  readonly intendedAdminUserId?: string;
  readonly intendedAdminEmail?: string;
  readonly ownerKeyOfflineBackupsReady?: boolean;
}): Promise<ProductionOwnerBootstrapPreflightOnlyResult> {
  if (process.env.OWNER_PRODUCTION_BOOTSTRAP_APPLY === '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'OWNER_PRODUCTION_BOOTSTRAP_APPLY is enabled - stop before DB connection in Step4B',
    );
  }

  const notes: string[] = [
    'preflight-only is read-only (BEGIN READ ONLY + ROLLBACK)',
    'OPERATIONAL_DB_MUTATION=NO',
    'unauthenticated diagnostics only - readyForOwnerBootstrapApply is always false',
  ];

  const discovered = await discoverProductionTrustedEndpoint(input.endpoint);
  const intendedId = (input.intendedAdminUserId ?? TARGET_ADMIN_CANDIDATE_ID).trim();

  return withReadOnlyClient({ ...input.endpoint, dialIp: discovered.dialIp }, async (client) => {
    const evaluated = await evaluateProductionOwnerBootstrapReadOnlyState(client, {
      intendedAdminUserId: intendedId,
      intendedAdminEmail: input.intendedAdminEmail?.trim() ?? null,
      trustAuthenticated: false,
      ownerKeyBackupsReady: input.ownerKeyOfflineBackupsReady === true,
      authenticatedBinding: null,
      endpoint: {
        dialIp: discovered.dialIp,
        tlsServerName: discovered.tlsServerName,
        databaseName: discovered.databaseName,
        systemIdentifier: discovered.systemIdentifier,
      },
      notes,
    });
    return { ...evaluated, trustAuthenticated: false, readyForOwnerBootstrapApply: false };
  });
}
