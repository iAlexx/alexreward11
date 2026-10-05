/**
 * Phase 13 — versioned provider limit change with PROVIDER_HARD ceiling enforcement.
 *
 * Platform/user/country scopes may be stricter than PROVIDER_HARD but never looser.
 * Creating a non-hard rule with maxCount above the active PROVIDER_HARD ceiling is refused.
 * History is append-only: prior ACTIVE rows are superseded; never mutated in place.
 */

import type { PoolClient } from 'pg';

import { HARD_LIMIT_SCOPES } from './constants.js';
import { withLedgerTransaction, type AdsDb } from './db.js';
import { AdsDomainError } from './errors.js';
import type {
  ProviderLimitMetric,
  ProviderLimitScope,
  ProviderLimitSourceType,
  ProviderLimitWindow,
} from './types.js';

export interface CreateProviderLimitRuleVersionInput {
  readonly providerCode: string;
  readonly limitScope: ProviderLimitScope;
  readonly limitMetric: ProviderLimitMetric;
  readonly limitWindow: ProviderLimitWindow;
  readonly maxCount: number;
  readonly sourceType: ProviderLimitSourceType;
  readonly sourceReference: string;
  readonly reason: string;
  readonly oldMaxCount: number;
  readonly expectedVersion: number;
  readonly adminUserId: string;
  readonly activate?: boolean;
  readonly countryCode?: string | null;
  readonly riskTier?: string | null;
  readonly impactPreview?: Record<string, unknown> | null;
  readonly validFrom?: Date;
}

export interface CreateProviderLimitRuleVersionResult {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly oldMaxCount: number;
  readonly newMaxCount: number;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly impactPreview: Record<string, unknown> | null;
  readonly status: string;
  readonly hardCeilingMaxCount: number | null;
}

const LIMIT_SCOPES: readonly ProviderLimitScope[] = [
  'PROVIDER_HARD',
  'CONTRACT',
  'PLATFORM_SOFT',
  'USER_TIER',
  'COUNTRY_OVERRIDE',
];

const LIMIT_METRICS: readonly ProviderLimitMetric[] = ['REQUEST', 'SUCCESS'];
const LIMIT_WINDOWS: readonly ProviderLimitWindow[] = ['HOUR', 'ROLLING_24H', 'UTC_DAY'];
const SOURCE_TYPES: readonly ProviderLimitSourceType[] = [
  'CONTRACT',
  'OFFICIAL_DOCUMENTATION',
  'WRITTEN_SUPPORT',
  'PROVIDER_ACCOUNT_CONFIG',
];

function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AdsDomainError('VALIDATION', `invalid ${label}`, {
      details: { value, allowed },
    });
  }
}

async function loadProviderId(client: PoolClient, providerCode: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ad_providers WHERE code = $1`,
    [providerCode],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('PROVIDER_NOT_FOUND', 'provider not found', {
      details: { providerCode },
    });
  }
  return row.id;
}

/**
 * Active PROVIDER_HARD / CONTRACT ceiling for a dimension (lowest max_count wins).
 */
export async function resolveActiveHardCeiling(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly limitMetric: ProviderLimitMetric;
    readonly limitWindow: ProviderLimitWindow;
    readonly countryCode?: string | null;
    readonly riskTier?: string | null;
    readonly asOf?: Date;
  },
): Promise<{ readonly maxCount: number; readonly ruleVersion: number } | null> {
  const asOf = input.asOf ?? new Date();
  const result = await client.query<{ max_count: number; rule_version: number }>(
    `SELECT max_count, rule_version
     FROM provider_limit_rules
     WHERE provider_id = $1::uuid
       AND limit_scope = ANY($2::provider_limit_scope[])
       AND limit_metric = $3::provider_limit_metric
       AND limit_window = $4::provider_limit_window
       AND status = 'ACTIVE'
       AND valid_from <= $5::timestamptz
       AND (valid_to IS NULL OR valid_to > $5::timestamptz)
       AND country_code IS NOT DISTINCT FROM $6
       AND risk_tier IS NOT DISTINCT FROM $7::risk_tier
     ORDER BY max_count ASC, rule_version DESC
     LIMIT 1`,
    [
      input.providerId,
      HARD_LIMIT_SCOPES,
      input.limitMetric,
      input.limitWindow,
      asOf.toISOString(),
      input.countryCode ?? null,
      input.riskTier ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { maxCount: row.max_count, ruleVersion: row.rule_version };
}

/**
 * Preview whether a proposed maxCount would exceed the PROVIDER_HARD ceiling.
 * Hard-scope replacements may raise the ceiling; non-hard scopes may not exceed it.
 */
export function wouldExceedProviderHardLimit(input: {
  readonly limitScope: string;
  readonly proposedMaxCount: number;
  readonly hardCeilingMaxCount: number | null;
}): boolean {
  if (HARD_LIMIT_SCOPES.includes(input.limitScope)) {
    return false;
  }
  if (input.hardCeilingMaxCount === null) {
    // No hard ceiling configured: refuse looser-than-hard platform rules fail-closed.
    return true;
  }
  return input.proposedMaxCount > input.hardCeilingMaxCount;
}

export async function createProviderLimitRuleVersion(
  db: AdsDb,
  input: CreateProviderLimitRuleVersionInput,
): Promise<CreateProviderLimitRuleVersionResult> {
  assertEnum(input.limitScope, LIMIT_SCOPES, 'limitScope');
  assertEnum(input.limitMetric, LIMIT_METRICS, 'limitMetric');
  assertEnum(input.limitWindow, LIMIT_WINDOWS, 'limitWindow');
  assertEnum(input.sourceType, SOURCE_TYPES, 'sourceType');

  if (!Number.isInteger(input.maxCount) || input.maxCount < 0) {
    throw new AdsDomainError('VALIDATION', 'maxCount must be a non-negative integer');
  }
  if (input.sourceReference.trim() === '' || input.reason.trim() === '') {
    throw new AdsDomainError('VALIDATION', 'sourceReference and reason are required');
  }

  return withLedgerTransaction(db, async (client) => {
    const providerId = await loadProviderId(client, input.providerCode);
    const validFrom = input.validFrom ?? new Date();
    const hard = await resolveActiveHardCeiling(client, {
      providerId,
      limitMetric: input.limitMetric,
      limitWindow: input.limitWindow,
      countryCode: input.countryCode ?? null,
      riskTier: input.riskTier ?? null,
      asOf: validFrom,
    });

    if (
      wouldExceedProviderHardLimit({
        limitScope: input.limitScope,
        proposedMaxCount: input.maxCount,
        hardCeilingMaxCount: hard?.maxCount ?? null,
      })
    ) {
      throw new AdsDomainError(
        'VALIDATION',
        'proposed limit exceeds PROVIDER_HARD ceiling; admin cannot exceed hard limit',
        {
          details: {
            reason: 'EXCEEDS_PROVIDER_HARD',
            proposedMaxCount: input.maxCount,
            hardCeilingMaxCount: hard?.maxCount ?? null,
            limitScope: input.limitScope,
          },
        },
      );
    }

    // Optimistic concurrency: expectedVersion must match current max version for this dimension.
    const versionRow = await client.query<{ max_version: string | null; current_max: number | null }>(
      `SELECT MAX(rule_version)::text AS max_version,
              (
                SELECT max_count
                FROM provider_limit_rules
                WHERE provider_id = $1::uuid
                  AND limit_scope = $2::provider_limit_scope
                  AND limit_metric = $3::provider_limit_metric
                  AND limit_window = $4::provider_limit_window
                  AND country_code IS NOT DISTINCT FROM $5
                  AND risk_tier IS NOT DISTINCT FROM $6::risk_tier
                  AND status = 'ACTIVE'
                ORDER BY rule_version DESC
                LIMIT 1
              ) AS current_max
       FROM provider_limit_rules
       WHERE provider_id = $1::uuid
         AND limit_scope = $2::provider_limit_scope
         AND limit_metric = $3::provider_limit_metric
         AND limit_window = $4::provider_limit_window
         AND country_code IS NOT DISTINCT FROM $5
         AND risk_tier IS NOT DISTINCT FROM $6::risk_tier`,
      [
        providerId,
        input.limitScope,
        input.limitMetric,
        input.limitWindow,
        input.countryCode ?? null,
        input.riskTier ?? null,
      ],
    );
    const maxVersion = Number(versionRow.rows[0]?.max_version ?? 0);
    if (input.expectedVersion !== maxVersion) {
      throw new AdsDomainError('VALIDATION', 'expectedVersion mismatch for provider limit rule', {
        details: {
          reason: 'VERSION_CONFLICT',
          expectedVersion: input.expectedVersion,
          actualVersion: maxVersion,
        },
      });
    }
    const currentMax = versionRow.rows[0]?.current_max ?? null;
    if (currentMax !== null && currentMax !== input.oldMaxCount) {
      throw new AdsDomainError('VALIDATION', 'oldMaxCount does not match active rule', {
        details: {
          reason: 'OLD_VALUE_MISMATCH',
          oldMaxCount: input.oldMaxCount,
          actualMaxCount: currentMax,
        },
      });
    }

    const nextVersion = maxVersion + 1;
    const status = input.activate === true ? 'ACTIVE' : 'DRAFT';
    const impactPreview = input.impactPreview ?? {
      oldMaxCount: input.oldMaxCount,
      newMaxCount: input.maxCount,
      hardCeilingMaxCount: hard?.maxCount ?? null,
    };

    if (status === 'ACTIVE') {
      await client.query(
        `UPDATE provider_limit_rules
         SET status = 'SUPERSEDED',
             valid_to = LEAST(COALESCE(valid_to, $7::timestamptz), $7::timestamptz),
             updated_at = now()
         WHERE provider_id = $1::uuid
           AND limit_scope = $2::provider_limit_scope
           AND limit_metric = $3::provider_limit_metric
           AND limit_window = $4::provider_limit_window
           AND country_code IS NOT DISTINCT FROM $5
           AND risk_tier IS NOT DISTINCT FROM $6::risk_tier
           AND status = 'ACTIVE'
           AND valid_from < $7::timestamptz
           AND (valid_to IS NULL OR valid_to > $7::timestamptz)`,
        [
          providerId,
          input.limitScope,
          input.limitMetric,
          input.limitWindow,
          input.countryCode ?? null,
          input.riskTier ?? null,
          validFrom.toISOString(),
        ],
      );
    }

    const approved =
      status === 'ACTIVE' && HARD_LIMIT_SCOPES.includes(input.limitScope)
        ? { adminId: input.adminUserId, at: validFrom }
        : { adminId: null as string | null, at: null as Date | null };

    const inserted = await client.query<{ id: string; rule_version: number; status: string }>(
      `INSERT INTO provider_limit_rules (
         provider_id, limit_scope, limit_metric, limit_window, country_code, risk_tier,
         max_count, rule_version, status, valid_from,
         source_type, source_reference, impact_preview, reason,
         approved_by_admin_id, approved_at
       ) VALUES (
         $1::uuid, $2::provider_limit_scope, $3::provider_limit_metric, $4::provider_limit_window,
         $5, $6::risk_tier, $7, $8, $9::rule_version_status, $10::timestamptz,
         $11::provider_limit_source_type, $12, $13::jsonb, $14,
         $15::uuid, $16::timestamptz
       )
       RETURNING id, rule_version, status`,
      [
        providerId,
        input.limitScope,
        input.limitMetric,
        input.limitWindow,
        input.countryCode ?? null,
        input.riskTier ?? null,
        input.maxCount,
        nextVersion,
        status,
        validFrom.toISOString(),
        input.sourceType,
        input.sourceReference,
        JSON.stringify(impactPreview),
        input.reason,
        approved.adminId,
        approved.at?.toISOString() ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new AdsDomainError('INTERNAL', 'provider limit rule insert failed');
    }

    return {
      ruleId: row.id,
      ruleVersion: row.rule_version,
      oldMaxCount: input.oldMaxCount,
      newMaxCount: input.maxCount,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference,
      impactPreview,
      status: row.status,
      hardCeilingMaxCount: hard?.maxCount ?? null,
    };
  });
}
