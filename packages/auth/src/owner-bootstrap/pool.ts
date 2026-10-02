/**
 * Bootstrap PostgreSQL pool construction bound to endpoint trust profile.
 *
 * Connection facts are derived from discrete PoolConfig fields and live session
 * (pg_stat_ssl / inet_server_addr), not from caller-supplied boolean flags.
 *
 * Never pass connectionString alongside an ssl object — node-postgres may replace
 * the ssl object when the URL contains sslmode / sslrootcert / sslcert / sslkey.
 *
 * production/staging verify_full: TLS required with Owner CA + hostname.
 * isolated_test loopback plaintext: URL host numeric loopback + non-public
 * live server address. Caller "localhost" label alone is insufficient.
 */
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Pool, type PoolConfig } from 'pg';

import {
  assertConnectedDestructiveTestDatabase,
  isApprovedDestructiveTestDatabaseName,
} from '@alex-rewards/db';

import { AuthDomainError } from '../errors.js';
import type { BootstrapEndpointProfile } from './endpoint.js';
import type { DeploymentEnv } from './grant.js';
import { buildVerifyFullTlsSocketOptions, assertSpkiPinningUnsupportedForV1 } from './tls-verify-full.js';

export interface BootstrapConnectionFacts {
  readonly hostname: string;
  readonly sslEnabled: boolean;
  readonly currentDatabase: string;
  readonly clusterSystemIdentifier: string;
  readonly serverAddr: string | null;
  readonly sslInUse: boolean;
}

export interface OwnerBootstrapPool {
  readonly pool: Pool;
  readonly connectionFacts: BootstrapConnectionFacts;
  /** Sanitized discrete connection summary — never a raw URL with secrets. */
  readonly hostname: string;
  readonly database: string;
  readonly profile: BootstrapEndpointProfile;
}

type PgConnectionStringParse = (connectionString: string) => Record<string, unknown>;
type BootstrapTlsMode = BootstrapEndpointProfile['tls'];

/** Verified pools from createOwnerBootstrapPool only. */
const verifiedBootstrapByPool = new WeakMap<Pool, OwnerBootstrapPool>();

/** Isolated-test clock overrides — WeakMap keyed by verified pool; never public API. */
const isolatedTestClockByPool = new WeakMap<Pool, number>();

const FORBIDDEN_SSL_URL_KEYS = new Set([
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'sslcrl',
  'sslnegotiation',
  'sslsni',
]);

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', `bootstrap connection ${label} missing`);
  }
  return value.trim();
}

function loadParse(): PgConnectionStringParse {
  const require = createRequire(import.meta.url);
  const pgEntry = require.resolve('pg');
  const parserModule = require(
    require.resolve('pg-connection-string', { paths: [dirname(pgEntry)] }),
  ) as PgConnectionStringParse & { parse?: PgConnectionStringParse };
  const parse = typeof parserModule.parse === 'function' ? parserModule.parse : parserModule;
  if (typeof parse !== 'function') {
    throw new AuthDomainError('INTERNAL', 'pg-connection-string parse unavailable');
  }
  return parse;
}

const parseConnectionString = loadParse();

function isNumericLoopback(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\/\d+$/, '');
  if (h === '127.0.0.1' || h === '::1') return true;
  const version = isIP(h);
  if (version === 4) return h.startsWith('127.');
  if (version === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
  return false;
}

function isPrivateOrLoopbackAddr(addr: string | null): boolean {
  if (addr === null) return true;
  const h = addr.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\/\d+$/, '');
  if (h === '') return false;
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
  return false;
}

/**
 * Reject libpq SSL URL parameters that would override / conflict with profile TLS.
 */
export function assertNoConflictingSslConnectionParams(
  connectionString: string,
  parsed: Record<string, unknown>,
): void {
  const lower = connectionString.toLowerCase();
  for (const key of FORBIDDEN_SSL_URL_KEYS) {
    if (lower.includes(`${key}=`)) {
      throw new AuthDomainError(
        'FORBIDDEN',
        `bootstrap connection URL must not contain ${key} (TLS is forced by endpoint profile only)`,
      );
    }
  }
  for (const key of Object.keys(parsed)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_SSL_URL_KEYS.has(normalized) || normalized === 'ssl') {
      throw new AuthDomainError(
        'FORBIDDEN',
        `bootstrap connection must not supply parsed SSL key ${key}; use endpoint profile TLS only`,
      );
    }
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t === '' ? undefined : t;
}

function optionalPort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Build a PoolConfig whose TLS settings are forced by the endpoint profile.
 * Uses discrete host/user/password/database/ssl — never connectionString+ssl together.
 */
export function buildOwnerBootstrapPoolConfig(
  connectionString: string,
  profile: BootstrapEndpointProfile,
): { readonly config: PoolConfig; readonly hostname: string; readonly database: string } {
  // Reject SSL URL params BEFORE parse — pg-connection-string may open sslrootcert paths.
  assertNoConflictingSslConnectionParams(connectionString, {});
  const parsed = parseConnectionString(connectionString);
  assertNoConflictingSslConnectionParams(connectionString, parsed);

  const hostname = asNonEmptyString(parsed['host'] ?? parsed['hostname'], 'host');
  const database = asNonEmptyString(parsed['database'], 'database');
  if (database === 'alex_rewards') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'bootstrap refuse operational alex_rewards (PRODUCTION TRUST ANCHOR NOT ESTABLISHED)',
    );
  }
  if (!isApprovedDestructiveTestDatabaseName(database)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'bootstrap requires approved isolated *_test / *_phaseN database name in URL',
    );
  }
  if (database !== profile.expectedDatabaseName) {
    throw new AuthDomainError('FORBIDDEN', 'URL database does not match endpoint profile');
  }

  const base: PoolConfig = {
    host: hostname,
    database,
    max: 4,
  };
  const port = optionalPort(parsed['port']);
  if (port !== undefined) base.port = port;
  const user = optionalString(parsed['user']);
  if (user !== undefined) base.user = user;
  const password = optionalString(parsed['password']);
  if (password !== undefined) base.password = password;

  const tls: BootstrapTlsMode = profile.tls;
  if (tls.mode === 'isolated_test_loopback_plaintext') {
    if (profile.deploymentEnv !== 'isolated_test') {
      throw new AuthDomainError('FORBIDDEN', 'loopback plaintext forbidden outside isolated_test');
    }
    if (!isNumericLoopback(hostname)) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'isolated_test plaintext requires numeric loopback host in URL (127.0.0.1 or ::1), not a DNS label',
      );
    }
    return {
      hostname,
      database,
      config: {
        ...base,
        ssl: false,
        application_name: 'alex-owner-bootstrap-isolated-test',
      },
    };
  }

  if (tls.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'Owner CA trust anchor missing; fail closed');
  }
  if (tls.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required; fail closed');
  }
  // CV-01: pg overwrites ssl.servername with non-IP URL hosts. Allow only IP dial targets
  // (SNI/profile name preserved) or URL host exactly equal to tls_server_name.
  const dialHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const approvedName = tls.tlsServerName.trim().toLowerCase();
  if (isIP(dialHost) === 0 && dialHost !== approvedName) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'URL host must be a numeric IP or exactly equal tls_server_name (pg would overwrite TLS servername with a mismatched DNS host)',
    );
  }
  const ssl = buildVerifyFullTlsSocketOptions({
    caPem: tls.caPem,
    tlsServerName: tls.tlsServerName,
    ...(tls.spkiSha256Hex !== undefined ? { spkiSha256Hex: tls.spkiSha256Hex } : {}),
  });

  return {
    hostname,
    database,
    config: {
      ...base,
      application_name: 'alex-owner-bootstrap-verify-full',
      ssl,
    },
  };
}

export async function createOwnerBootstrapPool(input: {
  readonly connectionString: string;
  readonly profile: BootstrapEndpointProfile;
}): Promise<OwnerBootstrapPool> {
  const built = buildOwnerBootstrapPoolConfig(input.connectionString, input.profile);
  const pool = new Pool(built.config);
  try {
    const client = await pool.connect();
    try {
      await assertConnectedDestructiveTestDatabase(client);
      const dbRes = await client.query<{ current_database: string }>(`SELECT current_database()`);
      const currentDatabase = dbRes.rows[0]?.current_database ?? '';
      if (currentDatabase !== built.database) {
        throw new AuthDomainError('FORBIDDEN', 'connected database != URL database');
      }
      const sidRes = await client.query<{ system_identifier: string }>(
        `SELECT system_identifier::text AS system_identifier FROM pg_control_system()`,
      );
      const clusterSystemIdentifier = sidRes.rows[0]?.system_identifier ?? '';
      const sslRes = await client.query<{ ssl: boolean | null }>(
        `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
      );
      const sslInUse = sslRes.rows[0]?.ssl === true;
      const addrRes = await client.query<{ server_addr: string | null }>(
        `SELECT inet_server_addr()::text AS server_addr`,
      );
      const serverAddr = addrRes.rows[0]?.server_addr ?? null;

      if (input.profile.tls.mode === 'isolated_test_loopback_plaintext') {
        if (serverAddr !== null && !isPrivateOrLoopbackAddr(serverAddr)) {
          throw new AuthDomainError(
            'FORBIDDEN',
            'isolated_test refused: inet_server_addr is a public non-loopback address (possible tunnel to remote)',
          );
        }
        if (built.config.ssl !== false && built.config.ssl !== undefined) {
          throw new AuthDomainError('FORBIDDEN', 'isolated_test plaintext pool misconfigured with ssl');
        }
      } else {
        if (!sslInUse) {
          throw new AuthDomainError(
            'FORBIDDEN',
            'TLS required but pg_stat_ssl reports ssl=false for this backend',
          );
        }
        if (built.config.ssl === false || built.config.ssl === undefined) {
          throw new AuthDomainError('FORBIDDEN', 'verify_full pool missing ssl configuration');
        }
      }

      if (
        input.profile.expectedSystemIdentifier !== undefined &&
        input.profile.expectedSystemIdentifier !== '' &&
        input.profile.expectedSystemIdentifier !== clusterSystemIdentifier
      ) {
        throw new AuthDomainError('FORBIDDEN', 'system_identifier mismatch');
      }

      const connectionFacts: BootstrapConnectionFacts = {
        hostname: built.hostname,
        sslEnabled: sslInUse,
        currentDatabase,
        clusterSystemIdentifier,
        serverAddr,
        sslInUse,
      };

      const result: OwnerBootstrapPool = {
        pool,
        connectionFacts,
        hostname: built.hostname,
        database: built.database,
        profile: input.profile,
      };
      verifiedBootstrapByPool.set(pool, result);
      return result;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Build trust material bound to a verified OwnerBootstrapPool.
 * connectionFacts / endpointProfile are the pool's own objects (reference identity).
 */
export function createBootstrapTrustMaterial(
  bootstrap: OwnerBootstrapPool,
  pinnedPublicKeys: ReadonlyMap<string, Uint8Array>,
): {
  readonly pinnedPublicKeys: ReadonlyMap<string, Uint8Array>;
  readonly endpointProfile: BootstrapEndpointProfile;
  readonly connectionFacts: BootstrapConnectionFacts;
} {
  if (verifiedBootstrapByPool.get(bootstrap.pool) !== bootstrap) {
    throw new AuthDomainError('FORBIDDEN', 'bootstrap pool is not registered as verified');
  }
  return {
    pinnedPublicKeys,
    endpointProfile: bootstrap.profile,
    connectionFacts: bootstrap.connectionFacts,
  };
}

/**
 * Refuse forged connectionFacts or an unverified / unrelated Pool.
 */
export function assertPoolBoundBootstrapTrust(
  pool: Pool,
  trust: {
    readonly endpointProfile: BootstrapEndpointProfile;
    readonly connectionFacts: BootstrapConnectionFacts;
  },
): void {
  const verified = verifiedBootstrapByPool.get(pool);
  if (verified === undefined) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'pool is not a createOwnerBootstrapPool-verified bootstrap pool',
    );
  }
  if (trust.connectionFacts !== verified.connectionFacts) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'connectionFacts are not bound to this verified pool (forged or unrelated)',
    );
  }
  if (trust.endpointProfile !== verified.profile) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'endpointProfile is not bound to this verified pool (forged or unrelated)',
    );
  }
}

/**
 * Isolated-test-only clock for deterministic expiry tests.
 * Requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1 and an isolated_test verified pool.
 * Cannot be enabled for operational / staging / production profiles.
 */
export function setIsolatedTestBootstrapClock(pool: Pool, nowSec: number): void {
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated test bootstrap clock requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
    );
  }
  if (!Number.isFinite(nowSec) || !Number.isInteger(nowSec)) {
    throw new AuthDomainError('VALIDATION', 'test clock must be an integer unix second');
  }
  const verified = verifiedBootstrapByPool.get(pool);
  if (verified === undefined) {
    throw new AuthDomainError('FORBIDDEN', 'test clock requires a verified bootstrap pool');
  }
  if (verified.profile.deploymentEnv !== 'isolated_test') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'test clock forbidden outside isolated_test deployment profile',
    );
  }
  if (verified.profile.tls.mode !== 'isolated_test_loopback_plaintext') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'test clock forbidden unless isolated_test_loopback_plaintext TLS mode',
    );
  }
  isolatedTestClockByPool.set(pool, nowSec);
}

export function clearIsolatedTestBootstrapClock(pool: Pool): void {
  isolatedTestClockByPool.delete(pool);
}

/** Peek isolated-test clock for preflight only — undefined unless hooks + verified isolated_test pool. */
export function peekIsolatedTestBootstrapClock(pool: Pool): number | undefined {
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') return undefined;
  const verified = verifiedBootstrapByPool.get(pool);
  if (
    verified === undefined ||
    verified.profile.deploymentEnv !== 'isolated_test' ||
    verified.profile.tls.mode !== 'isolated_test_loopback_plaintext'
  ) {
    return undefined;
  }
  return isolatedTestClockByPool.get(pool);
}

/**
 * Authoritative time for enrollment decisions.
 * Operational path: always PostgreSQL clock_timestamp().
 * Optional isolated-test clock only when set via setIsolatedTestBootstrapClock.
 */
export async function readAuthoritativeBootstrapNowSec(
  client: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> },
  pool: Pool,
): Promise<number> {
  const override = isolatedTestClockByPool.get(pool);
  if (override !== undefined) {
    if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
      isolatedTestClockByPool.delete(pool);
    } else {
      const verified = verifiedBootstrapByPool.get(pool);
      if (
        verified !== undefined &&
        verified.profile.deploymentEnv === 'isolated_test' &&
        verified.profile.tls.mode === 'isolated_test_loopback_plaintext'
      ) {
        return override;
      }
      isolatedTestClockByPool.delete(pool);
    }
  }
  const result = await client.query(
    `SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint::text AS n`,
  );
  const n = Number(result.rows[0]?.n);
  if (!Number.isFinite(n)) {
    throw new AuthDomainError('INTERNAL', 'clock_timestamp() unavailable');
  }
  return n;
}

export function assertBootstrapTlsAndEndpoint(
  profile: BootstrapEndpointProfile,
  grantEnv: DeploymentEnv,
  grantProfileId: string,
  connection: BootstrapConnectionFacts,
): void {
  if (profile.profileId !== grantProfileId) {
    throw new AuthDomainError('FORBIDDEN', 'endpoint_profile_id mismatch');
  }
  if (profile.deploymentEnv !== grantEnv) {
    throw new AuthDomainError('FORBIDDEN', 'deployment_env mismatch');
  }
  if (connection.currentDatabase === 'alex_rewards') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'bootstrap refuse operational alex_rewards (production trust anchor NOT ESTABLISHED; OPERATIONAL ENROLLMENT BLOCKED)',
    );
  }
  if (connection.currentDatabase !== profile.expectedDatabaseName) {
    throw new AuthDomainError('FORBIDDEN', 'expected_database_name mismatch');
  }
  if (!isApprovedDestructiveTestDatabaseName(connection.currentDatabase)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'bootstrap local Stage B requires approved isolated *_test / *_phaseN database',
    );
  }
  if (
    profile.expectedSystemIdentifier !== undefined &&
    profile.expectedSystemIdentifier !== '' &&
    profile.expectedSystemIdentifier !== connection.clusterSystemIdentifier
  ) {
    throw new AuthDomainError('FORBIDDEN', 'system_identifier mismatch');
  }

  if (profile.tls.mode === 'isolated_test_loopback_plaintext') {
    if (profile.deploymentEnv !== 'isolated_test' || grantEnv !== 'isolated_test') {
      throw new AuthDomainError(
        'FORBIDDEN',
        'loopback plaintext TLS mode forbidden outside isolated_test',
      );
    }
    if (!isNumericLoopback(connection.hostname)) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'loopback plaintext requires numeric loopback host (not DNS label alone)',
      );
    }
    if (connection.serverAddr !== null && !isPrivateOrLoopbackAddr(connection.serverAddr)) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'live server address is public non-loopback (refuse remote tunnel claiming loopback)',
      );
    }
    return;
  }

  if (!connection.sslInUse) {
    throw new AuthDomainError('FORBIDDEN', 'TLS required; plaintext refused');
  }
  if (profile.tls.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'Owner CA trust anchor missing; fail closed');
  }
  if (profile.tls.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required; fail closed');
  }
  assertSpkiPinningUnsupportedForV1(profile.tls.spkiSha256Hex, 'spkiSha256Hex');
}


/**
 * Production_sealed_v1 pool config — verify_full only; operational DB names allowed.
 * Does NOT weaken isolated Stage B path (buildOwnerBootstrapPoolConfig unchanged).
 */
export function buildProductionOwnerBootstrapPoolConfig(
  connectionString: string,
  profile: BootstrapEndpointProfile,
): { readonly config: PoolConfig; readonly hostname: string; readonly database: string } {
  if (profile.deploymentEnv !== 'production') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 pool requires deploymentEnv=production',
    );
  }
  if (profile.tls.mode !== 'verify_full') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 refuses non-verify_full TLS (no plaintext downgrade)',
    );
  }
  if (
    profile.expectedSystemIdentifier === undefined ||
    profile.expectedSystemIdentifier.trim() === ''
  ) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 requires expectedSystemIdentifier',
    );
  }
  assertNoConflictingSslConnectionParams(connectionString, {});
  const parsed = parseConnectionString(connectionString);
  assertNoConflictingSslConnectionParams(connectionString, parsed);

  const hostname = asNonEmptyString(parsed['host'] ?? parsed['hostname'], 'host');
  const database = asNonEmptyString(parsed['database'], 'database');
  if (database !== profile.expectedDatabaseName) {
    throw new AuthDomainError('FORBIDDEN', 'URL database does not match endpoint profile');
  }
  if (isNumericLoopback(hostname)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 refuses loopback plaintext / loopback dial targets',
    );
  }

  const base: PoolConfig = {
    host: hostname,
    database,
    max: 4,
  };
  const port = optionalPort(parsed['port']);
  if (port !== undefined) base.port = port;
  const user = optionalString(parsed['user']);
  if (user !== undefined) base.user = user;
  const password = optionalString(parsed['password']);
  if (password !== undefined) base.password = password;

  if (profile.tls.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'Owner CA trust anchor missing; fail closed');
  }
  if (profile.tls.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required; fail closed');
  }
  const dialHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const approvedName = profile.tls.tlsServerName.trim().toLowerCase();
  if (isIP(dialHost) === 0 && dialHost !== approvedName) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'URL host must be a numeric IP or exactly equal tls_server_name',
    );
  }
  const ssl = buildVerifyFullTlsSocketOptions({
    caPem: profile.tls.caPem,
    tlsServerName: profile.tls.tlsServerName,
    ...(profile.tls.spkiSha256Hex !== undefined
      ? { spkiSha256Hex: profile.tls.spkiSha256Hex }
      : {}),
  });

  return {
    hostname,
    database,
    config: {
      ...base,
      application_name: 'alex-owner-production-bootstrap-verify-full',
      ssl,
    },
  };
}

export async function createProductionOwnerBootstrapPool(input: {
  readonly connectionString: string;
  readonly profile: BootstrapEndpointProfile;
}): Promise<OwnerBootstrapPool> {
  const built = buildProductionOwnerBootstrapPoolConfig(input.connectionString, input.profile);
  const pool = new Pool(built.config);
  try {
    const client = await pool.connect();
    try {
      const dbRes = await client.query<{ current_database: string }>(`SELECT current_database()`);
      const currentDatabase = dbRes.rows[0]?.current_database ?? '';
      if (currentDatabase !== built.database) {
        throw new AuthDomainError('FORBIDDEN', 'connected database != URL database');
      }
      const sidRes = await client.query<{ system_identifier: string }>(
        `SELECT system_identifier::text AS system_identifier FROM pg_control_system()`,
      );
      const clusterSystemIdentifier = sidRes.rows[0]?.system_identifier ?? '';
      if (clusterSystemIdentifier !== input.profile.expectedSystemIdentifier) {
        throw new AuthDomainError('FORBIDDEN', 'system_identifier mismatch');
      }
      const sslRes = await client.query<{ ssl: boolean | null }>(
        `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
      );
      const sslInUse = sslRes.rows[0]?.ssl === true;
      if (!sslInUse) {
        throw new AuthDomainError(
          'FORBIDDEN',
          'TLS required but pg_stat_ssl reports ssl=false for this backend',
        );
      }
      const addrRes = await client.query<{ server_addr: string | null }>(
        `SELECT inet_server_addr()::text AS server_addr`,
      );
      const serverAddr = addrRes.rows[0]?.server_addr ?? null;
      const connectionFacts: BootstrapConnectionFacts = {
        hostname: built.hostname,
        sslEnabled: sslInUse,
        currentDatabase,
        clusterSystemIdentifier,
        serverAddr,
        sslInUse,
      };
      const result: OwnerBootstrapPool = {
        pool,
        connectionFacts,
        hostname: built.hostname,
        database: built.database,
        profile: input.profile,
      };
      verifiedBootstrapByPool.set(pool, result);
      return result;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Production TLS/endpoint assert — requires verify_full + system_identifier.
 * Isolated assertBootstrapTlsAndEndpoint remains unchanged (refuses ops DBs).
 */
export function assertProductionBootstrapTlsAndEndpoint(
  profile: BootstrapEndpointProfile,
  grantEnv: DeploymentEnv,
  grantProfileId: string,
  connection: BootstrapConnectionFacts,
): void {
  if (profile.profileId !== grantProfileId) {
    throw new AuthDomainError('FORBIDDEN', 'endpoint_profile_id mismatch');
  }
  if (profile.deploymentEnv !== 'production' || grantEnv !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'production_sealed_v1 requires production env');
  }
  if (connection.currentDatabase !== profile.expectedDatabaseName) {
    throw new AuthDomainError('FORBIDDEN', 'expected_database_name mismatch');
  }
  if (
    profile.expectedSystemIdentifier === undefined ||
    profile.expectedSystemIdentifier === '' ||
    profile.expectedSystemIdentifier !== connection.clusterSystemIdentifier
  ) {
    throw new AuthDomainError('FORBIDDEN', 'system_identifier mismatch');
  }
  if (profile.tls.mode !== 'verify_full') {
    throw new AuthDomainError('FORBIDDEN', 'production refuses non-verify_full TLS');
  }
  if (!connection.sslInUse) {
    throw new AuthDomainError('FORBIDDEN', 'TLS required; plaintext refused');
  }
  if (profile.tls.caPem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'Owner CA trust anchor missing; fail closed');
  }
  if (profile.tls.tlsServerName.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'tls_server_name required; fail closed');
  }
  if (isNumericLoopback(connection.hostname)) {
    throw new AuthDomainError('FORBIDDEN', 'production refuses loopback dial host');
  }
  assertSpkiPinningUnsupportedForV1(profile.tls.spkiSha256Hex, 'spkiSha256Hex');
}
