/**
 * Phase 21 canary payout PLAN — verified production DB connection (read-only).
 *
 * Reuses createPhase21CeremonyVerifiedPool / createProductionOwnerBootstrapPool
 * (verify_full TLS + DB identity). No Owner password/TOTP (APPLY-only).
 * Never prints DATABASE_URL or credentials. Never disables TLS verification.
 */
import {
  resolvePublicProxyDialIps,
  type CeremonyEndpointProfileV1,
} from '@alex-rewards/auth';

import {
  createPhase21CeremonyVerifiedPool,
  loadPhase21CeremonyEndpointProfile,
  type Phase21CeremonyVerifiedPool,
} from './phase21-ceremony-verified-pool.js';

export class Phase21CanaryPlanDbError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21CanaryPlanDbError';
    this.code = code;
    this.details = details;
  }
}

export type Phase21CanaryPlanDbVerificationEvidence = {
  readonly verifiedPool: true;
  readonly readOnly: true;
  readonly currentDatabase: string;
  readonly currentDatabaseMatchesProfile: boolean;
  readonly systemIdentifier: string;
  readonly systemIdentifierMatchesProfile: boolean;
  readonly sslInUse: true;
  readonly tlsMode: 'verify_full';
  readonly tlsServerName: string;
  readonly dialHostKind: 'public_proxy_ip';
  readonly proxyHostConfigured: true;
  /** Sanitized — never includes credentials or DATABASE_URL. */
  readonly sanitized: true;
};

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function argValue(argv: readonly string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return null;
  return value;
}

export function isRailwayInternalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return h === 'postgres.railway.internal' || h.endsWith('.railway.internal');
}

export function resolvePhase21CanaryPlanProxyHost(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = [
    env.PHASE21_CEREMONY_PROXY_HOST,
    env.RAILWAY_TCP_PROXY_HOST,
    env.RAILWAY_TCP_PROXY_DOMAIN,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return null;
}

export function resolvePhase21CanaryPlanProxyPort(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const candidates = [env.PHASE21_CEREMONY_PROXY_PORT, env.RAILWAY_TCP_PROXY_PORT];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return null;
}

export type Phase21CanaryPlanDbCredentials = {
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly sourceHost: string;
  readonly sourcePort: number | null;
};

/**
 * Extract credentials from DATABASE_URL without logging the URL.
 * Host from DATABASE_URL is never used as the dial target when it is railway.internal.
 */
export function extractCredentialsFromDatabaseUrl(
  databaseUrl: string,
): Phase21CanaryPlanDbCredentials {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Phase21CanaryPlanDbError(
      'DATABASE_URL_INVALID',
      'DATABASE_URL could not be parsed for credentials',
      {},
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Phase21CanaryPlanDbError(
      'DATABASE_URL_INVALID',
      'DATABASE_URL must use postgres/postgresql scheme',
      {},
    );
  }
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  const sourceHost = parsed.hostname;
  if (user === '' || password === '' || database === '' || sourceHost === '') {
    throw new Phase21CanaryPlanDbError(
      'DATABASE_URL_CREDENTIALS_INCOMPLETE',
      'DATABASE_URL must include user, password, host, and database name',
      {},
    );
  }
  const portRaw = parsed.port.trim();
  const sourcePort = portRaw === '' ? null : Number(portRaw);
  if (sourcePort !== null && (!Number.isInteger(sourcePort) || sourcePort <= 0)) {
    throw new Phase21CanaryPlanDbError('DATABASE_URL_INVALID', 'DATABASE_URL port invalid', {});
  }
  return { user, password, database, sourceHost, sourcePort };
}

export function loadPhase21CanaryPlanEndpointProfile(
  argv: readonly string[],
): CeremonyEndpointProfileV1 {
  const ceremonyDir = argValue(argv, '--ceremony-dir') ?? envNonEmpty('PHASE21_CEREMONY_DIR');
  const profileFile =
    argValue(argv, '--ceremony-endpoint-profile') ??
    envNonEmpty('PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE');
  try {
    return loadPhase21CeremonyEndpointProfile({
      ceremonyDir,
      profileFile,
    });
  } catch (error: unknown) {
    throw new Phase21CanaryPlanDbError(
      'CEREMONY_ENDPOINT_PROFILE_REQUIRED',
      'live PLAN requires --ceremony-endpoint-profile (or PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE / --ceremony-dir); generic DATABASE_URL pool is refused',
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function buildPhase21CanaryPlanVerifiedConnectionString(input: {
  readonly profile: CeremonyEndpointProfileV1;
  readonly databaseUrl: string;
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly resolveDialIps?: (proxyHostname: string) => Promise<readonly string[]>;
}): Promise<{
  readonly connectionString: string;
  readonly dialIp: string;
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly database: string;
}> {
  if (input.profile.tls.mode !== 'verify_full') {
    throw new Phase21CanaryPlanDbError(
      'VERIFY_FULL_TLS_REQUIRED',
      'Phase 21 canary PLAN requires ceremony profile tls.mode=verify_full',
      { mode: input.profile.tls.mode },
    );
  }
  const creds = extractCredentialsFromDatabaseUrl(input.databaseUrl);
  if (creds.database !== input.profile.expected_database_name) {
    throw new Phase21CanaryPlanDbError(
      'PLAN_DATABASE_IDENTITY_MISMATCH',
      'DATABASE_URL database name does not match ceremony endpoint profile expected_database_name',
      {
        databaseUrlDatabase: creds.database,
        profileDatabase: input.profile.expected_database_name,
      },
    );
  }
  if (isRailwayInternalHostname(input.proxyHost)) {
    throw new Phase21CanaryPlanDbError(
      'RAILWAY_INTERNAL_HOST_FORBIDDEN_FROM_WORKSTATION',
      'proxy host must not be postgres.railway.internal from the Owner workstation',
      {},
    );
  }

  const resolve = input.resolveDialIps ?? resolvePublicProxyDialIps;
  const dialIps = await resolve(input.proxyHost);
  const dialIp = dialIps[0];
  if (dialIp === undefined) {
    throw new Phase21CanaryPlanDbError(
      'PROXY_DIAL_IP_UNRESOLVED',
      'no public dial IP resolved for Railway TCP proxy host',
      {},
    );
  }

  const userEnc = encodeURIComponent(creds.user);
  const passEnc = encodeURIComponent(creds.password);
  const dbEnc = encodeURIComponent(input.profile.expected_database_name);
  // Dial numeric IP so pg preserves tls.servername = profile tls_server_name (verify_full).
  const connectionString = `postgresql://${userEnc}:${passEnc}@${dialIp}:${input.proxyPort}/${dbEnc}`;
  return {
    connectionString,
    dialIp,
    proxyHost: input.proxyHost,
    proxyPort: input.proxyPort,
    database: input.profile.expected_database_name,
  };
}

export type Phase21CanaryPlanVerifiedDb = {
  readonly verified: Phase21CeremonyVerifiedPool;
  readonly profile: CeremonyEndpointProfileV1;
  readonly evidence: Phase21CanaryPlanDbVerificationEvidence;
  readonly close: () => Promise<void>;
};

/**
 * Open read-only PLAN DB via existing ceremony verified pool.
 * Does NOT authenticate Owner (APPLY-only). Fail closed on TLS/identity mismatch.
 */
export async function openPhase21CanaryPlanVerifiedPool(input: {
  readonly argv: readonly string[];
  readonly databaseUrl?: string | null;
  readonly resolveDialIps?: (proxyHostname: string) => Promise<readonly string[]>;
  readonly createVerifiedPool?: typeof createPhase21CeremonyVerifiedPool;
}): Promise<Phase21CanaryPlanVerifiedDb> {
  const profile = loadPhase21CanaryPlanEndpointProfile(input.argv);
  if (profile.tls.mode !== 'verify_full') {
    throw new Phase21CanaryPlanDbError(
      'VERIFY_FULL_TLS_REQUIRED',
      'Phase 21 canary PLAN requires ceremony profile tls.mode=verify_full',
      { mode: profile.tls.mode },
    );
  }
  if (
    profile.expected_system_identifier === undefined ||
    profile.expected_system_identifier.trim() === ''
  ) {
    throw new Phase21CanaryPlanDbError(
      'SYSTEM_IDENTIFIER_REQUIRED',
      'ceremony endpoint profile must include expected_system_identifier for PLAN',
      {},
    );
  }

  const databaseUrl = input.databaseUrl ?? envNonEmpty('DATABASE_URL');
  if (databaseUrl === null) {
    throw new Phase21CanaryPlanDbError(
      'LIVE_DATABASE_REQUIRED_FOR_PLAN',
      'DATABASE_URL required for credentials (routing uses Railway TCP proxy + verify_full profile)',
      {},
    );
  }

  const proxyHost = resolvePhase21CanaryPlanProxyHost();
  const proxyPort = resolvePhase21CanaryPlanProxyPort();
  if (proxyHost === null || proxyPort === null) {
    throw new Phase21CanaryPlanDbError(
      'CEREMONY_PROXY_REQUIRED',
      'PHASE21_CEREMONY_PROXY_HOST/PORT or RAILWAY_TCP_PROXY_HOST|DOMAIN + RAILWAY_TCP_PROXY_PORT required for workstation PLAN',
      {},
    );
  }

  const built = await buildPhase21CanaryPlanVerifiedConnectionString({
    profile,
    databaseUrl,
    proxyHost,
    proxyPort,
    ...(input.resolveDialIps !== undefined ? { resolveDialIps: input.resolveDialIps } : {}),
  });

  const createPool = input.createVerifiedPool ?? createPhase21CeremonyVerifiedPool;
  let verified: Phase21CeremonyVerifiedPool;
  try {
    verified = await createPool({
      connectionString: built.connectionString,
      profile,
    });
  } catch (error: unknown) {
    if (error instanceof Phase21CanaryPlanDbError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/system_identifier mismatch/i.test(message)) {
      throw new Phase21CanaryPlanDbError(
        'PLAN_SYSTEM_IDENTIFIER_MISMATCH',
        'live system_identifier does not match ceremony endpoint profile',
        {},
      );
    }
    if (/expected_database_name mismatch|connected database|URL database/i.test(message)) {
      throw new Phase21CanaryPlanDbError(
        'PLAN_DATABASE_IDENTITY_MISMATCH',
        'live current_database does not match ceremony endpoint profile',
        {},
      );
    }
    if (/verify_full|TLS required|ssl=false|Owner CA|tls_server_name/i.test(message)) {
      throw new Phase21CanaryPlanDbError(
        'VERIFY_FULL_TLS_REQUIRED',
        'verify_full TLS could not be established for canary PLAN',
        { cause: message },
      );
    }
    throw new Phase21CanaryPlanDbError(
      'PLAN_VERIFIED_POOL_OPEN_FAILED',
      'failed to open ceremony verified pool for canary PLAN',
      { cause: message },
    );
  }

  if (!verified.sslInUse) {
    await verified.close().catch(() => undefined);
    throw new Phase21CanaryPlanDbError(
      'VERIFY_FULL_TLS_REQUIRED',
      'verified pool opened without sslInUse=true — refuse PLAN',
      {},
    );
  }

  const evidence: Phase21CanaryPlanDbVerificationEvidence = {
    verifiedPool: true,
    readOnly: true,
    currentDatabase: verified.databaseName,
    currentDatabaseMatchesProfile: verified.databaseName === profile.expected_database_name,
    systemIdentifier: verified.systemIdentifier,
    systemIdentifierMatchesProfile:
      verified.systemIdentifier === (profile.expected_system_identifier ?? ''),
    sslInUse: true,
    tlsMode: 'verify_full',
    tlsServerName: verified.tlsServerName,
    dialHostKind: 'public_proxy_ip',
    proxyHostConfigured: true,
    sanitized: true,
  };

  if (!evidence.currentDatabaseMatchesProfile || !evidence.systemIdentifierMatchesProfile) {
    await verified.close().catch(() => undefined);
    throw new Phase21CanaryPlanDbError(
      !evidence.currentDatabaseMatchesProfile
        ? 'PLAN_DATABASE_IDENTITY_MISMATCH'
        : 'PLAN_SYSTEM_IDENTIFIER_MISMATCH',
      'verified pool identity does not match ceremony endpoint profile',
      {
        currentDatabaseMatchesProfile: evidence.currentDatabaseMatchesProfile,
        systemIdentifierMatchesProfile: evidence.systemIdentifierMatchesProfile,
      },
    );
  }

  return {
    verified,
    profile,
    evidence,
    close: () => verified.close(),
  };
}

/** Source/CLI gate: production live PLAN must not open a generic pg Pool. */
export function refuseGenericPoolForPhase21CanaryPlan(): Phase21CanaryPlanDbError {
  return new Phase21CanaryPlanDbError(
    'GENERIC_POOL_REFUSED_FOR_PRODUCTION_PLAN',
    'production live canary PLAN refuses generic DATABASE_URL Pool; use ceremony verified pool (--ceremony-endpoint-profile + TCP proxy + verify_full)',
    {},
  );
}
