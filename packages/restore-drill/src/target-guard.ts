/**
 * Fail-closed isolated restore-target guard.
 * Isolation is host/service based — NEVER DATABASE_URL fallback.
 * Application DB names (e.g. alex_rewards) may legitimately match source after PITR restore.
 */

import type { Pool } from 'pg';

import type { RestoreTargetFingerprint } from './types.js';

/** Template / system catalogs only — NOT application DB names. */
export const FORBIDDEN_RESTORE_DATABASE_NAMES = ['postgres', 'template0', 'template1'] as const;

export interface PostgresEndpointIdentity {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

export interface RestoreDrillEnvConfig {
  readonly enabled: boolean;
  readonly restoreDatabaseUrl: string | null;
  readonly expectedDatabaseName: string | null;
  readonly expectedHost: string | null;
  readonly sourceDatabaseHost: string | null;
  readonly featureFlagEnvironment: string | null;
  readonly verifyUserIds: readonly string[];
  readonly verifyAllUsers: boolean;
  readonly sourceCountCapturePath: string | null;
  readonly temporalAddress: string | null;
  readonly temporalNamespace: string | null;
  readonly drillMode: 'DB_ONLY_STEP2A' | 'FULL_STEP2B';
  readonly databaseUrlPresent: boolean;
  readonly databaseUrl: string | null;
}

export type TargetGuardFailure =
  | 'DRILL_DISABLED'
  | 'RESTORE_DATABASE_URL_MISSING'
  | 'EXPECTED_DATABASE_NAME_MISSING'
  | 'EXPECTED_HOST_MISSING'
  | 'EXPECTED_HOST_MISMATCH'
  | 'SOURCE_HOST_MISSING'
  | 'SOURCE_TARGET_HOST_NOT_DISTINCT'
  | 'FEATURE_FLAG_ENVIRONMENT_MISSING'
  | 'DATABASE_URL_FALLBACK_REFUSED'
  | 'RESTORE_ENDPOINT_EQUALS_DATABASE_URL'
  | 'FORBIDDEN_TEMPLATE_DATABASE_NAME'
  | 'CURRENT_DATABASE_MISMATCH'
  | 'UNPARSEABLE_RESTORE_URL'
  | 'READ_ONLY_NOT_ENFORCED'
  | 'CONNECT_FAILED'
  | 'VERIFY_USERS_AMBIGUOUS'
  | 'SOURCE_COUNT_CAPTURE_MISSING'
  | 'TEMPORAL_CONFIG_MISSING'
  | 'VERIFY_ALL_USERS_MODE_INVALID'
  | 'INVALID_DRILL_MODE';

export class RestoreTargetGuardError extends Error {
  readonly code: TargetGuardFailure;
  constructor(code: TargetGuardFailure, message: string) {
    super(message);
    this.name = 'RestoreTargetGuardError';
    this.code = code;
  }
}

export function parseRestoreDrillEnv(
  env: NodeJS.ProcessEnv = process.env,
): RestoreDrillEnvConfig {
  const enabled = (env.PHASE18_RESTORE_DRILL_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  const restoreDatabaseUrl = nonempty(env.PHASE18_RESTORE_DATABASE_URL);
  const expectedDatabaseName = nonempty(env.PHASE18_RESTORE_EXPECTED_DATABASE_NAME);
  const expectedHost = nonempty(env.PHASE18_RESTORE_EXPECTED_HOST);
  const sourceDatabaseHost = nonempty(env.PHASE18_SOURCE_DATABASE_HOST);
  const featureFlagEnvironment = nonempty(env.PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT);
  const databaseUrl = nonempty(env.DATABASE_URL);
  const verifyUserIds = (env.PHASE18_RESTORE_VERIFY_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const verifyAllUsers =
    (env.PHASE18_RESTORE_VERIFY_ALL_USERS ?? 'false').trim().toLowerCase() === 'true';
  const sourceCountCapturePath = nonempty(env.PHASE18_SOURCE_COUNT_CAPTURE_PATH);
  const temporalAddress = nonempty(env.PHASE18_TEMPORAL_ADDRESS);
  const temporalNamespace = nonempty(env.PHASE18_TEMPORAL_NAMESPACE);
  let drillMode: 'DB_ONLY_STEP2A' | 'FULL_STEP2B';
  if (env.PHASE18_RESTORE_DRILL_MODE === undefined) {
    drillMode = 'DB_ONLY_STEP2A';
  } else {
    const modeRaw = env.PHASE18_RESTORE_DRILL_MODE.trim();
    if (modeRaw === 'DB_ONLY_STEP2A' || modeRaw === 'FULL_STEP2B') {
      drillMode = modeRaw;
    } else {
      throw new RestoreTargetGuardError(
        'INVALID_DRILL_MODE',
        'PHASE18_RESTORE_DRILL_MODE must be exactly DB_ONLY_STEP2A or FULL_STEP2B',
      );
    }
  }

  return {
    enabled,
    restoreDatabaseUrl,
    expectedDatabaseName,
    expectedHost,
    sourceDatabaseHost,
    featureFlagEnvironment,
    verifyUserIds,
    verifyAllUsers,
    sourceCountCapturePath,
    temporalAddress,
    temporalNamespace,
    drillMode,
    databaseUrlPresent: databaseUrl !== null,
    databaseUrl,
  };
}

function nonempty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Normalize postgres URL to host/port/database — ignores credentials. */
export function parseEndpointIdentity(connectionString: string): PostgresEndpointIdentity | null {
  try {
    const url = new URL(connectionString);
    const host = url.hostname.trim().toLowerCase();
    if (host === '') return null;
    const defaultPort =
      url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? '5432' : '';
    const port = (url.port || defaultPort).trim();
    const database = decodeURIComponent(url.pathname.replace(/^\//, '')).trim().toLowerCase();
    return { host, port, database };
  } catch {
    return null;
  }
}

export function endpointIdentitiesEqual(
  a: PostgresEndpointIdentity,
  b: PostgresEndpointIdentity,
): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase();
}

export function assertRestoreDrillEnabled(config: RestoreDrillEnvConfig): void {
  if (!config.enabled) {
    throw new RestoreTargetGuardError(
      'DRILL_DISABLED',
      'PHASE18_RESTORE_DRILL_ENABLED must be true (default false)',
    );
  }
}

export interface BoundRestoreTarget {
  readonly restoreDatabaseUrl: string;
  readonly expectedDatabaseName: string;
  readonly expectedHost: string;
  readonly sourceDatabaseHost: string | null;
  readonly featureFlagEnvironment: string;
  readonly targetEndpoint: PostgresEndpointIdentity;
}

/**
 * Validate env before any DB connect. Refuses DATABASE_URL fallback.
 * Isolation evidence is host/service based — DB name may match source.
 */
export function assertRestoreTargetEnv(
  config: RestoreDrillEnvConfig,
  options: { readonly mode?: 'DB_ONLY_STEP2A' | 'FULL_STEP2B' } = {},
): BoundRestoreTarget {
  const mode = options.mode ?? 'DB_ONLY_STEP2A';
  assertRestoreDrillEnabled(config);

  if (config.restoreDatabaseUrl === null) {
    throw new RestoreTargetGuardError(
      'RESTORE_DATABASE_URL_MISSING',
      'PHASE18_RESTORE_DATABASE_URL is required; DATABASE_URL fallback is forbidden',
    );
  }
  if (config.expectedDatabaseName === null) {
    throw new RestoreTargetGuardError(
      'EXPECTED_DATABASE_NAME_MISSING',
      'PHASE18_RESTORE_EXPECTED_DATABASE_NAME is required',
    );
  }
  if (config.expectedHost === null) {
    throw new RestoreTargetGuardError(
      'EXPECTED_HOST_MISSING',
      'PHASE18_RESTORE_EXPECTED_HOST is required',
    );
  }
  if (config.featureFlagEnvironment === null) {
    throw new RestoreTargetGuardError(
      'FEATURE_FLAG_ENVIRONMENT_MISSING',
      'PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT is required',
    );
  }

  const targetEndpoint = parseEndpointIdentity(config.restoreDatabaseUrl);
  if (targetEndpoint === null) {
    throw new RestoreTargetGuardError(
      'UNPARSEABLE_RESTORE_URL',
      'PHASE18_RESTORE_DATABASE_URL could not be parsed for host identity',
    );
  }

  const expectedHost = normalizeHostname(config.expectedHost);
  if (targetEndpoint.host !== expectedHost) {
    throw new RestoreTargetGuardError(
      'EXPECTED_HOST_MISMATCH',
      `restore URL host "${targetEndpoint.host}" does not equal PHASE18_RESTORE_EXPECTED_HOST`,
    );
  }

  if (config.databaseUrl !== null) {
    const operational = parseEndpointIdentity(config.databaseUrl);
    if (operational !== null && endpointIdentitiesEqual(targetEndpoint, operational)) {
      throw new RestoreTargetGuardError(
        'RESTORE_ENDPOINT_EQUALS_DATABASE_URL',
        'PHASE18_RESTORE_DATABASE_URL endpoint identity must differ from DATABASE_URL (credentials ignored)',
      );
    }
  }

  const sourceHostRaw = config.sourceDatabaseHost;
  if (mode === 'FULL_STEP2B' && sourceHostRaw === null) {
    throw new RestoreTargetGuardError(
      'SOURCE_HOST_MISSING',
      'PHASE18_SOURCE_DATABASE_HOST is required for FULL_STEP2B',
    );
  }
  if (mode === 'FULL_STEP2B') {
    if (config.verifyAllUsers && config.verifyUserIds.length > 0) {
      throw new RestoreTargetGuardError(
        'VERIFY_USERS_AMBIGUOUS',
        'PHASE18_RESTORE_VERIFY_ALL_USERS and PHASE18_RESTORE_VERIFY_USER_IDS are mutually exclusive',
      );
    }
    if (config.sourceCountCapturePath === null) {
      throw new RestoreTargetGuardError(
        'SOURCE_COUNT_CAPTURE_MISSING',
        'PHASE18_SOURCE_COUNT_CAPTURE_PATH is required for FULL_STEP2B',
      );
    }
    if (config.temporalAddress === null || config.temporalNamespace === null) {
      throw new RestoreTargetGuardError(
        'TEMPORAL_CONFIG_MISSING',
        'PHASE18_TEMPORAL_ADDRESS and PHASE18_TEMPORAL_NAMESPACE are required for FULL_STEP2B',
      );
    }
  }
  if (config.verifyAllUsers && mode !== 'FULL_STEP2B') {
    throw new RestoreTargetGuardError(
      'VERIFY_ALL_USERS_MODE_INVALID',
      'PHASE18_RESTORE_VERIFY_ALL_USERS is only allowed with FULL_STEP2B',
    );
  }
  if (sourceHostRaw !== null) {
    const sourceHost = normalizeHostname(sourceHostRaw);
    if (sourceHost === targetEndpoint.host) {
      throw new RestoreTargetGuardError(
        'SOURCE_TARGET_HOST_NOT_DISTINCT',
        'restore target host must differ from PHASE18_SOURCE_DATABASE_HOST',
      );
    }
  }

  const normalizedExpectedDb = config.expectedDatabaseName.trim().toLowerCase();
  if ((FORBIDDEN_RESTORE_DATABASE_NAMES as readonly string[]).includes(normalizedExpectedDb)) {
    throw new RestoreTargetGuardError(
      'FORBIDDEN_TEMPLATE_DATABASE_NAME',
      `expected database name "${config.expectedDatabaseName}" is a forbidden template/system name`,
    );
  }

  return {
    restoreDatabaseUrl: config.restoreDatabaseUrl,
    expectedDatabaseName: config.expectedDatabaseName,
    expectedHost,
    sourceDatabaseHost: sourceHostRaw === null ? null : normalizeHostname(sourceHostRaw),
    featureFlagEnvironment: config.featureFlagEnvironment,
    targetEndpoint,
  };
}

/** Redact password/userinfo from a postgres URL for reports. */
export function redactDatabaseUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    if (url.username) url.username = '***';
    return `${url.protocol}//${url.username ? `${url.username}:***@` : ''}${url.host}${url.pathname}`;
  } catch {
    return '[UNPARSEABLE_URL_REDACTED]';
  }
}

export async function assertConnectedRestoreTarget(
  pool: Pool,
  bound: BoundRestoreTarget,
  options: { readonly databaseReadOnlyEnforced: boolean },
): Promise<RestoreTargetFingerprint> {
  let currentDatabase: string;
  let postgresVersion: string | null = null;
  try {
    const db = await pool.query<{ current_database: string }>(
      'SELECT current_database() AS current_database',
    );
    currentDatabase = db.rows[0]?.current_database ?? '';
    const ver = await pool.query<{ version: string }>('SELECT version() AS version');
    postgresVersion = ver.rows[0]?.version ?? null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RestoreTargetGuardError(
      'CONNECT_FAILED',
      `restore target connect/query failed: ${message}`,
    );
  }

  if (currentDatabase.trim() === '') {
    throw new RestoreTargetGuardError('CONNECT_FAILED', 'current_database() returned empty');
  }

  const normalizedCurrent = currentDatabase.trim().toLowerCase();
  if ((FORBIDDEN_RESTORE_DATABASE_NAMES as readonly string[]).includes(normalizedCurrent)) {
    throw new RestoreTargetGuardError(
      'FORBIDDEN_TEMPLATE_DATABASE_NAME',
      `current_database()="${currentDatabase}" is a forbidden template/system name`,
    );
  }

  const targetDatabaseNameMatchesExpected =
    normalizedCurrent === bound.expectedDatabaseName.trim().toLowerCase();
  if (!targetDatabaseNameMatchesExpected) {
    throw new RestoreTargetGuardError(
      'CURRENT_DATABASE_MISMATCH',
      `current_database()="${currentDatabase}" does not match expected "${bound.expectedDatabaseName}"`,
    );
  }

  let schemaMigrationHead: string | null = null;
  let schemaMigrationCount: number | null = null;
  try {
    const present = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
    );
    if (present.rows[0]?.present === true) {
      const head = await pool.query<{ version: string; count: string }>(
        `SELECT
           (SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1) AS version,
           (SELECT COUNT(*)::text FROM schema_migrations) AS count`,
      );
      schemaMigrationHead = head.rows[0]?.version ?? null;
      schemaMigrationCount = Number(head.rows[0]?.count ?? 0);
    }
  } catch {
    schemaMigrationHead = null;
    schemaMigrationCount = null;
  }

  const targetHost = bound.targetEndpoint.host;
  const sourceHostProvided = bound.sourceDatabaseHost !== null;
  const targetDistinctFromSource =
    bound.sourceDatabaseHost === null ? null : bound.sourceDatabaseHost !== targetHost;

  return {
    currentDatabase,
    expectedDatabase: bound.expectedDatabaseName,
    targetHost,
    sourceHostProvided,
    sourceHost: bound.sourceDatabaseHost,
    targetDistinctFromSource,
    targetDatabaseName: currentDatabase,
    targetDatabaseNameMatchesExpected: true,
    databaseReadOnlyEnforced: options.databaseReadOnlyEnforced,
    postgresVersion,
    schemaMigrationHead,
    schemaMigrationCount,
    redactedTargetSummary: redactDatabaseUrl(bound.restoreDatabaseUrl),
  };
}

/** Explicit: evaluation path never uses DATABASE_URL as connection string. */
export const RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED = false as const;
