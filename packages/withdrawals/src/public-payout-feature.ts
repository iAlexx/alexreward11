/**
 * Phase 17 — PUBLIC_PAYOUT_LOGS_ENABLED feature authority (DB feature_flags).
 * process.env is NOT runtime publication authority.
 *
 * Deferred Owner policies (not decided in Step 2):
 * - HISTORICAL_BACKFILL_POLICY: OWNER_POLICY_REQUIRED
 * - MULTIPLE_DESTINATION_POLICY: OWNER_POLICY_REQUIRED
 * - TESTNET_PUBLICATION_POLICY: OWNER_POLICY_REQUIRED (STAGING/PRODUCTION fail closed)
 */

import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export type PublicPayoutFeatureEnvironment = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
export type PublicPayoutLogsFeatureFlagState = 'ENABLED' | 'DISABLED' | 'MISSING';

/**
 * Map deployment env string to feature_flags.environment.
 * local/test -> LOCAL; staging -> STAGING; production -> PRODUCTION; unknown -> CONFIG.
 */
export function mapDeploymentEnvToFeatureEnvironment(
  env: string,
): PublicPayoutFeatureEnvironment {
  const normalized = String(env).trim().toLowerCase();
  switch (normalized) {
    case 'local':
    case 'test':
      return 'LOCAL';
    case 'staging':
      return 'STAGING';
    case 'production':
      return 'PRODUCTION';
    default:
      throw new WithdrawalDomainError(
        'CONFIG',
        `Unsupported deployment env for public payout feature: ${env}`,
        { details: { env } },
      );
  }
}

/**
 * Pure parser for flag string/boolean values (unit tests / tooling only).
 * Do NOT use process.env as runtime publication authority.
 */
export function parsePublicPayoutLogsEnabledFlag(
  value: string | boolean | null | undefined,
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/** @deprecated Use parsePublicPayoutLogsEnabledFlag — kept for transitional imports. */
export const isPublicPayoutLogsEnabled = parsePublicPayoutLogsEnabledFlag;

export async function readPublicPayoutLogsFeatureFlag(
  client: PoolClient,
  environment: PublicPayoutFeatureEnvironment,
): Promise<PublicPayoutLogsFeatureFlagState> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'PUBLIC_PAYOUT_LOGS_ENABLED'
       AND environment = $1::environment_name`,
    [environment],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return 'MISSING';
  }
  return row.enabled === true ? 'ENABLED' : 'DISABLED';
}
