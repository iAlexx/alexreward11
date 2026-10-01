/**
 * Fail-closed isolated restore-target guard.
 * NEVER falls back to DATABASE_URL.
 */

import type { Pool } from 'pg';

import type { RestoreTargetFingerprint } from './types.js';

/** Known operational / default names that must never be restore-drill targets. */
export const FORBIDDEN_RESTORE_DATABASE_NAMES = [
  'alex_rewards',
  'postgres',
  'template0',
  'template1',
  'railway',
] as const;

export interface RestoreDrillEnvConfig {
  readonly enabled: boolean;
  readonly restoreDatabaseUrl: string | null;
  readonly expectedDatabaseName: string | null;
  readonly featureFlagEnvironment: string | null;
  readonly verifyUserIds: readonly string[];
  readonly databaseUrlPresent: boolean;
  readonly databaseUrlEqualsRestoreUrl: boolean;
}

export type TargetGuardFailure =
  | 'DRILL_DISABLED'
  | 'RESTORE_DATABASE_URL_MISSING'
  | 'EXPECTED_DATABASE_NAME_MISSING'
  | 'FEATURE_FLAG_ENVIRONMENT_MISSING'
  | 'DATABASE_URL_FALLBACK_REFUSED'
  | 'RESTORE_URL_EQUALS_DATABASE_URL'
  | 'FORBIDDEN_OPERATIONAL_DATABASE_NAME'
  | 'CURRENT_DATABASE_MISMATCH'
  | 'CONNECT_FAILED';

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
  const featureFlagEnvironment = nonempty(env.PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT);
  const databaseUrl = nonempty(env.DATABASE_URL);
  const verifyUserIds = (env.PHASE18_RESTORE_VERIFY_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  return {
    enabled,
    restoreDatabaseUrl,
    expectedDatabaseName,
    featureFlagEnvironment,
    verifyUserIds,
    databaseUrlPresent: databaseUrl !== null,
    databaseUrlEqualsRestoreUrl:
      databaseUrl !== null &&
      restoreDatabaseUrl !== null &&
      databaseUrl === restoreDatabaseUrl,
  };
}

function nonempty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function assertRestoreDrillEnabled(config: RestoreDrillEnvConfig): void {
  if (!config.enabled) {
    throw new RestoreTargetGuardError(
      'DRILL_DISABLED',
      'PHASE18_RESTORE_DRILL_ENABLED must be true (default false)',
    );
  }
}

/**
 * Validate env before any DB connect. Refuses DATABASE_URL fallback.
 */
export function assertRestoreTargetEnv(config: RestoreDrillEnvConfig): {
  readonly restoreDatabaseUrl: string;
  readonly expectedDatabaseName: string;
  readonly featureFlagEnvironment: string;
} {
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
  if (config.featureFlagEnvironment === null) {
    throw new RestoreTargetGuardError(
      'FEATURE_FLAG_ENVIRONMENT_MISSING',
      'PHASE18_RESTORE_FEATURE_FLAG_ENVIRONMENT is required',
    );
  }
  if (config.databaseUrlEqualsRestoreUrl) {
    throw new RestoreTargetGuardError(
      'RESTORE_URL_EQUALS_DATABASE_URL',
      'PHASE18_RESTORE_DATABASE_URL must not equal DATABASE_URL (operational target refusal)',
    );
  }

  const normalizedExpected = config.expectedDatabaseName.toLowerCase();
  if ((FORBIDDEN_RESTORE_DATABASE_NAMES as readonly string[]).includes(normalizedExpected)) {
    throw new RestoreTargetGuardError(
      'FORBIDDEN_OPERATIONAL_DATABASE_NAME',
      `expected database name "${config.expectedDatabaseName}" is a forbidden operational/default name`,
    );
  }

  return {
    restoreDatabaseUrl: config.restoreDatabaseUrl,
    expectedDatabaseName: config.expectedDatabaseName,
    featureFlagEnvironment: config.featureFlagEnvironment,
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
  expectedDatabaseName: string,
  restoreDatabaseUrl: string,
): Promise<RestoreTargetFingerprint> {
  let currentDatabase: string;
  let postgresVersion: string | null = null;
  try {
    const db = await pool.query<{ current_database: string }>('SELECT current_database() AS current_database');
    currentDatabase = db.rows[0]?.current_database ?? '';
    const ver = await pool.query<{ version: string }>('SELECT version() AS version');
    postgresVersion = ver.rows[0]?.version ?? null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RestoreTargetGuardError('CONNECT_FAILED', `restore target connect/query failed: ${message}`);
  }

  if (currentDatabase.trim() === '') {
    throw new RestoreTargetGuardError('CONNECT_FAILED', 'current_database() returned empty');
  }

  const normalizedCurrent = currentDatabase.trim().toLowerCase();
  if ((FORBIDDEN_RESTORE_DATABASE_NAMES as readonly string[]).includes(normalizedCurrent)) {
    throw new RestoreTargetGuardError(
      'FORBIDDEN_OPERATIONAL_DATABASE_NAME',
      `current_database()="${currentDatabase}" is a forbidden operational/default name`,
    );
  }

  if (normalizedCurrent !== expectedDatabaseName.trim().toLowerCase()) {
    throw new RestoreTargetGuardError(
      'CURRENT_DATABASE_MISMATCH',
      `current_database()="${currentDatabase}" does not match expected "${expectedDatabaseName}"`,
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

  return {
    currentDatabase,
    expectedDatabase: expectedDatabaseName,
    postgresVersion,
    schemaMigrationHead,
    schemaMigrationCount,
    redactedTargetSummary: redactDatabaseUrl(restoreDatabaseUrl),
  };
}

/** Explicit: evaluation path never uses DATABASE_URL as connection string. */
export const RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED = false as const;
