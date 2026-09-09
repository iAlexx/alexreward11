import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export interface FeeDiscountEntitlement {
  readonly userMembershipId: string;
  readonly ruleVersionId: string;
  readonly discountBps: number;
}

export interface PriorityEntitlement {
  readonly userMembershipId: string;
  readonly ruleVersionId: string;
  readonly enabled: true;
}

/**
 * Resolve WITHDRAWAL_PLATFORM_FEE_DISCOUNT via membership → plan → entitlement → benefit rule.
 * Binding integrity: mbr.entitlement_id = mpe.entitlement_id and plan-compatible rule.
 * Founder status alone yields zero discount without an active approved entitlement rule.
 * Ambiguous FINANCIAL candidates → FAIL CLOSED.
 */
export async function resolvePlatformFeeDiscount(
  client: PoolClient,
  input: { readonly userId: string; readonly assetId: string; readonly asOf: Date },
): Promise<FeeDiscountEntitlement | null> {
  const result = await client.query<{
    membership_id: string;
    rule_version_id: string;
    value_bps: number | null;
  }>(
    `SELECT um.id AS membership_id,
            mbr.id AS rule_version_id,
            mbr.value_bps
     FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.membership_plan_id
     JOIN membership_plan_entitlements mpe ON mpe.membership_plan_id = mp.id
     JOIN entitlements e ON e.id = mpe.entitlement_id
     JOIN membership_benefit_rule_versions mbr
       ON mbr.id = mpe.rule_version_id
      AND mbr.entitlement_id = mpe.entitlement_id
      AND (mbr.membership_plan_id IS NULL OR mbr.membership_plan_id = mp.id)
     WHERE um.user_id = $1::uuid
       AND um.status = 'ACTIVE'
       AND (um.expires_at IS NULL OR um.expires_at > $2::timestamptz)
       AND um.revoked_at IS NULL
       AND mp.status = 'ACTIVE'
       AND mpe.status = 'ACTIVE'
       AND mpe.valid_from <= $2::timestamptz
       AND (mpe.valid_to IS NULL OR mpe.valid_to > $2::timestamptz)
       AND e.code = 'WITHDRAWAL_PLATFORM_FEE_DISCOUNT'
       AND e.security_classification = 'FINANCIAL'
       AND e.value_type = 'BPS'
       AND mbr.status = 'ACTIVE'
       AND mbr.effective_from <= $2::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $2::timestamptz)
       AND (mbr.asset_id IS NULL OR mbr.asset_id = $3::uuid)`,
    [input.userId, input.asOf.toISOString(), input.assetId],
  );
  if (result.rowCount === 0) return null;
  if ((result.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError(
      'ENTITLEMENT_AMBIGUOUS',
      'Ambiguous platform fee discount entitlements',
    );
  }
  const row = result.rows[0]!;
  if (row.value_bps === null) {
    throw new WithdrawalDomainError('VALIDATION', 'Fee discount entitlement missing BPS value');
  }
  return {
    userMembershipId: row.membership_id,
    ruleVersionId: row.rule_version_id,
    discountBps: row.value_bps,
  };
}

/**
 * Resolve PRIORITY_WITHDRAWAL_REVIEW (INTERNAL BOOLEAN catalogue).
 * Same binding integrity as fee discount. Queue order only — never a security bypass.
 */
export async function resolvePriorityReview(
  client: PoolClient,
  input: { readonly userId: string; readonly asOf: Date },
): Promise<PriorityEntitlement | null> {
  const result = await client.query<{
    membership_id: string;
    rule_version_id: string;
    value_boolean: boolean | null;
  }>(
    `SELECT um.id AS membership_id,
            mbr.id AS rule_version_id,
            mbr.value_boolean
     FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.membership_plan_id
     JOIN membership_plan_entitlements mpe ON mpe.membership_plan_id = mp.id
     JOIN entitlements e ON e.id = mpe.entitlement_id
     JOIN membership_benefit_rule_versions mbr
       ON mbr.id = mpe.rule_version_id
      AND mbr.entitlement_id = mpe.entitlement_id
      AND (mbr.membership_plan_id IS NULL OR mbr.membership_plan_id = mp.id)
     WHERE um.user_id = $1::uuid
       AND um.status = 'ACTIVE'
       AND (um.expires_at IS NULL OR um.expires_at > $2::timestamptz)
       AND um.revoked_at IS NULL
       AND mp.status = 'ACTIVE'
       AND mpe.status = 'ACTIVE'
       AND mpe.valid_from <= $2::timestamptz
       AND (mpe.valid_to IS NULL OR mpe.valid_to > $2::timestamptz)
       AND e.code = 'PRIORITY_WITHDRAWAL_REVIEW'
       AND e.security_classification = 'INTERNAL'
       AND e.value_type = 'BOOLEAN'
       AND mbr.status = 'ACTIVE'
       AND mbr.effective_from <= $2::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $2::timestamptz)`,
    [input.userId, input.asOf.toISOString()],
  );
  if (result.rowCount === 0) return null;
  if ((result.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError(
      'ENTITLEMENT_AMBIGUOUS',
      'Ambiguous priority withdrawal entitlements',
    );
  }
  const row = result.rows[0]!;
  if (row.value_boolean !== true) return null;
  return {
    userMembershipId: row.membership_id,
    ruleVersionId: row.rule_version_id,
    enabled: true,
  };
}
