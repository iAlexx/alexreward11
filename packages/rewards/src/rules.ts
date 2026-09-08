import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import type {
  CreateRewardRuleVersionCommand,
  ResolveRewardRuleContext,
  RewardRuleRecord,
  RewardSourceType,
  RuleVersionStatus,
} from './types.js';

interface RuleRow {
  id: string;
  code: string;
  rule_version: number;
  source_type: RewardSourceType;
  provider_id: string | null;
  country_group: string | null;
  asset_id: string;
  user_share_bps: number | null;
  safety_factor_bps: number | null;
  estimated_ecpm_atomic: string | null;
  min_reward_atomic: string | null;
  max_reward_atomic: string | null;
  fixed_reward_atomic: string | null;
  pending_hold_seconds: number;
  quote_ttl_seconds: number;
  parameters: Record<string, unknown>;
  status: RuleVersionStatus;
  valid_from: Date;
  valid_to: Date | null;
}

function mapRule(row: RuleRow): RewardRuleRecord {
  return {
    id: row.id,
    code: row.code,
    ruleVersion: row.rule_version,
    sourceType: row.source_type,
    providerId: row.provider_id,
    countryGroup: row.country_group,
    assetId: row.asset_id,
    userShareBps: row.user_share_bps,
    safetyFactorBps: row.safety_factor_bps,
    estimatedEcpmAtomic: row.estimated_ecpm_atomic,
    minRewardAtomic: row.min_reward_atomic,
    maxRewardAtomic: row.max_reward_atomic,
    fixedRewardAtomic: row.fixed_reward_atomic,
    pendingHoldSeconds: row.pending_hold_seconds,
    quoteTtlSeconds: row.quote_ttl_seconds,
    parameters: row.parameters,
    status: row.status,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to === null ? null : row.valid_to.toISOString(),
  };
}

function atomicOrNull(value: bigint | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return amountAtomicToString(typeof value === 'bigint' ? value : BigInt(value.trim()));
}

export async function createRewardRuleVersion(
  client: PoolClient,
  command: CreateRewardRuleVersionCommand,
): Promise<RewardRuleRecord> {
  if (command.code.trim() === '') {
    throw new RewardDomainError('VALIDATION', 'reward rule code is required');
  }
  const versionResult = await client.query<{ next_version: string }>(
    `SELECT COALESCE(MAX(rule_version), 0) + 1 AS next_version
     FROM reward_rules WHERE code = $1`,
    [command.code],
  );
  const ruleVersion = Number(versionResult.rows[0]?.next_version ?? 1);
  const status: RuleVersionStatus = command.activate === true ? 'ACTIVE' : 'DRAFT';
  const validFrom = command.validFrom ?? new Date();

  if (status === 'ACTIVE') {
    await client.query(
      `UPDATE reward_rules
       SET status = 'SUPERSEDED',
           valid_to = LEAST(COALESCE(valid_to, $2::timestamptz), $2::timestamptz),
           updated_at = now()
       WHERE code = $1
         AND status = 'ACTIVE'
         AND valid_from < $2::timestamptz
         AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
      [command.code, validFrom.toISOString()],
    );
  }

  const inserted = await client.query<RuleRow>(
    `INSERT INTO reward_rules (
       code, rule_version, source_type, provider_id, country_group, asset_id,
       user_share_bps, safety_factor_bps, estimated_ecpm_atomic,
       min_reward_atomic, max_reward_atomic, fixed_reward_atomic,
       pending_hold_seconds, quote_ttl_seconds, parameters,
       status, valid_from, reason, source_reference, created_by_admin_id
     ) VALUES (
       $1, $2, $3::reward_source_type, $4::uuid, $5, $6::uuid,
       $7, $8, $9::bigint, $10::bigint, $11::bigint, $12::bigint,
       $13, $14, $15::jsonb, $16::rule_version_status, $17::timestamptz, $18, $19, $20::uuid
     )
     RETURNING id, code, rule_version, source_type, provider_id, country_group, asset_id,
               user_share_bps, safety_factor_bps, estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
               min_reward_atomic::text AS min_reward_atomic, max_reward_atomic::text AS max_reward_atomic,
               fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds, quote_ttl_seconds,
               parameters, status, valid_from, valid_to`,
    [
      command.code,
      ruleVersion,
      command.sourceType,
      command.providerId ?? null,
      command.countryGroup ?? null,
      command.assetId,
      command.userShareBps ?? null,
      command.safetyFactorBps ?? null,
      atomicOrNull(command.estimatedEcpmAtomic),
      atomicOrNull(command.minRewardAtomic),
      atomicOrNull(command.maxRewardAtomic),
      atomicOrNull(command.fixedRewardAtomic),
      command.pendingHoldSeconds ?? 0,
      command.quoteTtlSeconds ?? 300,
      JSON.stringify(command.parameters ?? {}),
      status,
      validFrom.toISOString(),
      command.reason ?? null,
      command.sourceReference ?? null,
      command.createdByAdminId ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new RewardDomainError('INTERNAL', 'reward rule insert failed');
  return mapRule(row);
}

export async function activateRewardRuleVersion(
  client: PoolClient,
  ruleId: string,
  asOf: Date = new Date(),
): Promise<RewardRuleRecord> {
  const current = await client.query<RuleRow>(
    `SELECT id, code, rule_version, source_type, provider_id, country_group, asset_id,
            user_share_bps, safety_factor_bps, estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
            min_reward_atomic::text AS min_reward_atomic, max_reward_atomic::text AS max_reward_atomic,
            fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds, quote_ttl_seconds,
            parameters, status, valid_from, valid_to
     FROM reward_rules WHERE id = $1 FOR UPDATE`,
    [ruleId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('RULE_NOT_FOUND', 'reward rule version not found', {
      details: { ruleId },
    });
  }
  if (row.status === 'ACTIVE') return mapRule(row);
  if (row.status !== 'DRAFT') {
    throw new RewardDomainError('VALIDATION', 'only DRAFT reward rules can be activated', {
      details: { ruleId, status: row.status },
    });
  }

  await client.query(
    `UPDATE reward_rules
     SET status = 'SUPERSEDED',
         valid_to = LEAST(COALESCE(valid_to, $2::timestamptz), $2::timestamptz),
         updated_at = now()
     WHERE code = $1
       AND status = 'ACTIVE'
       AND id <> $3
       AND valid_from < $2::timestamptz
       AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
    [row.code, asOf.toISOString(), ruleId],
  );

  const updated = await client.query<RuleRow>(
    `UPDATE reward_rules
     SET status = 'ACTIVE', updated_at = now()
     WHERE id = $1
     RETURNING id, code, rule_version, source_type, provider_id, country_group, asset_id,
               user_share_bps, safety_factor_bps, estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
               min_reward_atomic::text AS min_reward_atomic, max_reward_atomic::text AS max_reward_atomic,
               fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds, quote_ttl_seconds,
               parameters, status, valid_from, valid_to`,
    [ruleId],
  );
  const activated = updated.rows[0];
  if (activated === undefined) {
    throw new RewardDomainError('INTERNAL', 'reward rule activation failed');
  }
  return mapRule(activated);
}

export async function supersedeRewardRuleVersion(
  client: PoolClient,
  ruleId: string,
  asOf: Date = new Date(),
): Promise<RewardRuleRecord> {
  const updated = await client.query<RuleRow>(
    `UPDATE reward_rules
     SET status = 'SUPERSEDED',
         valid_to = LEAST(COALESCE(valid_to, $2::timestamptz), $2::timestamptz),
         updated_at = now()
     WHERE id = $1
     RETURNING id, code, rule_version, source_type, provider_id, country_group, asset_id,
               user_share_bps, safety_factor_bps, estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
               min_reward_atomic::text AS min_reward_atomic, max_reward_atomic::text AS max_reward_atomic,
               fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds, quote_ttl_seconds,
               parameters, status, valid_from, valid_to`,
    [ruleId, asOf.toISOString()],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('RULE_NOT_FOUND', 'reward rule version not found', {
      details: { ruleId },
    });
  }
  return mapRule(row);
}

/**
 * Resolve exactly one ACTIVE reward rule for context at asOf.
 * Logical family is reward_rules.code; context filters may still match multiple codes → fail closed.
 */
export async function resolveRewardRule(
  client: PoolClient,
  asOf: Date,
  context: ResolveRewardRuleContext,
): Promise<RewardRuleRecord> {
  const result = await client.query<RuleRow>(
    `SELECT id, code, rule_version, source_type, provider_id, country_group, asset_id,
            user_share_bps, safety_factor_bps, estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
            min_reward_atomic::text AS min_reward_atomic, max_reward_atomic::text AS max_reward_atomic,
            fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds, quote_ttl_seconds,
            parameters, status, valid_from, valid_to
     FROM reward_rules
     WHERE status = 'ACTIVE'
       AND source_type = $1::reward_source_type
       AND asset_id = $2::uuid
       AND valid_from <= $3::timestamptz
       AND (valid_to IS NULL OR valid_to > $3::timestamptz)
       AND (provider_id IS NULL OR provider_id = $4::uuid)
       AND (country_group IS NULL OR country_group = $5)
     ORDER BY code ASC, rule_version DESC`,
    [
      context.sourceType,
      context.assetId,
      asOf.toISOString(),
      context.providerId ?? null,
      context.countryGroup ?? null,
    ],
  );

  if (result.rows.length === 0) {
    throw new RewardDomainError('RULE_NOT_FOUND', 'no ACTIVE reward rule matches context', {
      details: { ...context, asOf: asOf.toISOString() },
    });
  }
  if (result.rows.length > 1) {
    throw new RewardDomainError(
      'RULE_AMBIGUOUS',
      'multiple ACTIVE reward rules match context; fail closed',
      {
        details: {
          matchCount: result.rows.length,
          codes: result.rows.map((row) => row.code),
        },
      },
    );
  }
  const only = result.rows[0];
  if (only === undefined) {
    throw new RewardDomainError('RULE_NOT_FOUND', 'no ACTIVE reward rule matches context');
  }
  return mapRule(only);
}
