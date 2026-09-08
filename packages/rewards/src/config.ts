import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import type {
  CreateBenefitRuleVersionCommand,
  CreateExposureLimitVersionCommand,
} from './types.js';

/**
 * Owner/internal: create an economic exposure limit version (no public HTTP).
 * Rows are append-only (0013); do not mutate prior versions in place.
 * Overlapping ACTIVE windows fail closed via EXCLUDE.
 */
export async function createExposureLimitVersion(
  client: PoolClient,
  command: CreateExposureLimitVersionCommand,
): Promise<{ id: string; ruleVersion: number; status: string }> {
  if (
    (command.limitAtomic === undefined || command.limitAtomic === null) ===
    (command.limitBps === undefined || command.limitBps === null)
  ) {
    throw new RewardDomainError('VALIDATION', 'exactly one of limitAtomic or limitBps is required');
  }
  const status = command.activate === true ? 'ACTIVE' : 'DRAFT';
  const effectiveFrom = command.effectiveFrom ?? new Date();

  const limitAtomic =
    command.limitAtomic === undefined || command.limitAtomic === null
      ? null
      : amountAtomicToString(
          typeof command.limitAtomic === 'bigint'
            ? command.limitAtomic
            : BigInt(command.limitAtomic.trim()),
        );

  try {
    const inserted = await client.query<{ id: string; rule_version: number; status: string }>(
      `INSERT INTO economic_exposure_limits (
         limit_code, environment, scope_reference_id, country_group, asset_id,
         limit_atomic, limit_bps, rule_version, status, effective_from, effective_to, reason
       ) VALUES (
         $1::exposure_limit_code, $2::environment_name, $3::uuid, $4, $5::uuid,
         $6::bigint, $7, $8, $9::rule_version_status, $10::timestamptz, $11::timestamptz, $12
       )
       RETURNING id, rule_version, status`,
      [
        command.limitCode,
        command.environment,
        command.scopeReferenceId ?? null,
        command.countryGroup ?? null,
        command.assetId ?? null,
        limitAtomic,
        command.limitBps ?? null,
        command.ruleVersion,
        status,
        effectiveFrom.toISOString(),
        command.effectiveTo?.toISOString() ?? null,
        command.reason ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new RewardDomainError('INTERNAL', 'exposure limit insert failed');
    return { id: row.id, ruleVersion: row.rule_version, status: row.status };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23P01'
    ) {
      throw new RewardDomainError(
        'CONFIG_CONFLICT',
        'overlapping ACTIVE economic exposure limit window',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Owner/internal: create a membership benefit rule version (no public HTTP).
 * Rows are append-only (0013); prior versions must be inserted with closed windows.
 */
export async function createBenefitRuleVersion(
  client: PoolClient,
  command: CreateBenefitRuleVersionCommand,
): Promise<{ id: string; ruleVersion: number; status: string }> {
  const values = [
    command.valueBoolean,
    command.valueBps,
    command.valueInteger,
    command.valueAtomic,
    command.valueEnum,
  ].filter((value) => value !== undefined && value !== null);
  if (values.length !== 1) {
    throw new RewardDomainError('VALIDATION', 'exactly one typed benefit value is required');
  }

  const status = command.activate === true ? 'ACTIVE' : 'DRAFT';
  const effectiveFrom = command.effectiveFrom ?? new Date();

  const valueAtomic =
    command.valueAtomic === undefined || command.valueAtomic === null
      ? null
      : amountAtomicToString(
          typeof command.valueAtomic === 'bigint'
            ? command.valueAtomic
            : BigInt(command.valueAtomic.trim()),
        );
  const valueInteger =
    command.valueInteger === undefined || command.valueInteger === null
      ? null
      : typeof command.valueInteger === 'bigint'
        ? command.valueInteger.toString(10)
        : command.valueInteger.trim();

  try {
    const inserted = await client.query<{ id: string; rule_version: number; status: string }>(
      `INSERT INTO membership_benefit_rule_versions (
         entitlement_id, membership_plan_id, rule_version,
         value_boolean, value_bps, value_integer, value_atomic, value_enum,
         asset_id, status, effective_from, effective_to, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3,
         $4, $5, $6::bigint, $7::bigint, $8,
         $9::uuid, $10::rule_version_status, $11::timestamptz, $12::timestamptz, $13
       )
       RETURNING id, rule_version, status`,
      [
        command.entitlementId,
        command.membershipPlanId ?? null,
        command.ruleVersion,
        command.valueBoolean ?? null,
        command.valueBps ?? null,
        valueInteger,
        valueAtomic,
        command.valueEnum ?? null,
        command.assetId ?? null,
        status,
        effectiveFrom.toISOString(),
        command.effectiveTo?.toISOString() ?? null,
        command.reason ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new RewardDomainError('INTERNAL', 'benefit rule insert failed');
    return { id: row.id, ruleVersion: row.rule_version, status: row.status };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23P01'
    ) {
      throw new RewardDomainError(
        'CONFIG_CONFLICT',
        'overlapping ACTIVE membership benefit rule window',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function setFeatureFlagEnabled(
  client: PoolClient,
  input: {
    readonly flagKey: string;
    readonly environment: 'LOCAL' | 'STAGING' | 'PRODUCTION';
    readonly enabled: boolean;
  },
): Promise<void> {
  const updated = await client.query(
    `UPDATE feature_flags
     SET enabled = $3, updated_at = now()
     WHERE flag_key = $1 AND environment = $2::environment_name`,
    [input.flagKey, input.environment, input.enabled],
  );
  if (updated.rowCount === 0) {
    throw new RewardDomainError('CONFIG_CONFLICT', 'feature flag not found', {
      details: input,
    });
  }
}

/** Bind a plan entitlement to a benefit rule version for tests/Owner config. */
export async function bindPlanEntitlement(
  client: PoolClient,
  input: {
    readonly membershipPlanId: string;
    readonly entitlementId: string;
    readonly ruleVersionId: string;
    readonly validFrom?: Date;
  },
): Promise<{ id: string }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO membership_plan_entitlements (
       membership_plan_id, entitlement_id, rule_version_id, valid_from, status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, 'ACTIVE')
     RETURNING id`,
    [
      input.membershipPlanId,
      input.entitlementId,
      input.ruleVersionId,
      (input.validFrom ?? new Date()).toISOString(),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new RewardDomainError('INTERNAL', 'plan entitlement bind failed');
  return { id: row.id };
}
