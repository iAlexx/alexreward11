/**
 * Effective referral rate authority.
 *
 * REFERRAL_RATE_BOOST is a REPLACEMENT effective rate profile (not base + boost).
 * No hardcoded 500/700 bps. Does not issue money.
 */
import type { PoolClient } from 'pg';

import { ReferralDomainError } from './errors.js';
import { resolveActiveReferralRuleVersionForEvaluation } from './referral-rule.js';

export const REFERRAL_RATE_BOOST_CODE = 'REFERRAL_RATE_BOOST' as const;

export type ReferralRateSource = 'BASE_RULE' | 'MEMBERSHIP_PROFILE';

export interface EffectiveReferralRate {
  readonly effectiveRateBps: number;
  readonly baseRateBps: number;
  readonly referralRuleVersion: number;
  readonly rateSource: ReferralRateSource;
  readonly userMembershipId: string | null;
  readonly entitlementRuleVersionId: string | null;
}

/**
 * Resolve the referrer's effective referral rate at server evaluation time.
 * Locks the ACTIVE referral rule FOR SHARE and locks selected membership rows FOR SHARE.
 */
export async function resolveEffectiveReferralRate(
  client: PoolClient,
  input: {
    readonly referrerUserId: string;
    readonly assetId: string;
  },
): Promise<EffectiveReferralRate> {
  if (typeof input.referrerUserId !== 'string' || input.referrerUserId.trim() === '') {
    throw new ReferralDomainError('INTERNAL', 'referrerUserId is required');
  }
  if (typeof input.assetId !== 'string' || input.assetId.trim() === '') {
    throw new ReferralDomainError('INTERNAL', 'assetId is required');
  }

  const rule = await resolveActiveReferralRuleVersionForEvaluation(client);
  const nowResult = await client.query<{ now: Date }>(`SELECT now() AS now`);
  const at = nowResult.rows[0]?.now;
  if (at === undefined) {
    throw new ReferralDomainError('INTERNAL', 'failed to read server now()');
  }

  const candidates = await client.query<{
    user_membership_id: string;
    entitlement_rule_version_id: string;
    value_bps: number;
  }>(
    `SELECT um.id AS user_membership_id,
            mbr.id AS entitlement_rule_version_id,
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
       AND e.code = $3
       AND e.security_classification = 'FINANCIAL'
       AND e.value_type = 'BPS'
       AND mbr.status = 'ACTIVE'
       AND mbr.effective_from <= $2::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $2::timestamptz)
       AND mbr.value_bps IS NOT NULL
       AND mbr.value_bps BETWEEN 0 AND 10000
       AND (mbr.asset_id IS NULL OR mbr.asset_id = $4::uuid)
     FOR SHARE OF um, mpe, mbr`,
    [input.referrerUserId, at.toISOString(), REFERRAL_RATE_BOOST_CODE, input.assetId],
  );

  if (candidates.rows.length === 0) {
    return {
      effectiveRateBps: rule.baseRateBps,
      baseRateBps: rule.baseRateBps,
      referralRuleVersion: rule.ruleVersion,
      rateSource: 'BASE_RULE',
      userMembershipId: null,
      entitlementRuleVersionId: null,
    };
  }

  if (candidates.rows.length > 1) {
    throw new ReferralDomainError(
      'REFERRAL_ENTITLEMENT_AMBIGUOUS',
      'Ambiguous REFERRAL_RATE_BOOST FINANCIAL BPS entitlements',
      {
        referrerUserId: input.referrerUserId,
        candidateCount: candidates.rows.length,
      },
    );
  }

  const row = candidates.rows[0]!;
  return {
    effectiveRateBps: row.value_bps,
    baseRateBps: rule.baseRateBps,
    referralRuleVersion: rule.ruleVersion,
    rateSource: 'MEMBERSHIP_PROFILE',
    userMembershipId: row.user_membership_id,
    entitlementRuleVersionId: row.entitlement_rule_version_id,
  };
}
