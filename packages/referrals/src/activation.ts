/**
 * Authoritative referral edge activation (PENDING → ACTIVE | REJECTED).
 *
 * Does not issue referral money. Caller supplies only edgeId.
 */
import type { PoolClient } from 'pg';

import { ReferralDomainError } from './errors.js';
import { resolveActiveReferralRuleVersionForEvaluation } from './referral-rule.js';

export const CRITICAL_FRAUD_REJECTION_REASON = 'CRITICAL_FRAUD_FLAG' as const;

export type ReferralActivationOutcome =
  | {
      readonly outcome: 'ACTIVATED';
      readonly edgeId: string;
      readonly state: 'ACTIVE';
      readonly activationRuleVersion: number;
      readonly accountAgeSeconds: number;
      readonly requiredAccountAgeSeconds: number;
      readonly validAdCount: number;
      readonly requiredValidAdCount: number;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly edgeId: string;
      readonly state: 'REJECTED';
      readonly activationRuleVersion: number;
      readonly rejectionReason: typeof CRITICAL_FRAUD_REJECTION_REASON;
      readonly accountAgeSeconds: number;
      readonly requiredAccountAgeSeconds: number;
      readonly validAdCount: number;
      readonly requiredValidAdCount: number;
    }
  | {
      readonly outcome: 'STILL_PENDING';
      readonly edgeId: string;
      readonly state: 'PENDING';
      readonly reasons: ReadonlyArray<'ACCOUNT_AGE_PENDING' | 'VALID_AD_COUNT_PENDING'>;
      readonly accountAgeSeconds: number;
      readonly requiredAccountAgeSeconds: number;
      readonly validAdCount: number;
      readonly requiredValidAdCount: number;
    }
  | {
      readonly outcome: 'ALREADY_ACTIVE';
      readonly edgeId: string;
      readonly state: 'ACTIVE';
      readonly activationRuleVersion: number | null;
    }
  | {
      readonly outcome: 'ALREADY_REJECTED';
      readonly edgeId: string;
      readonly state: 'REJECTED';
      readonly rejectionReason: string | null;
      readonly activationRuleVersion: number | null;
    };

interface EdgeRow {
  id: string;
  referred_user_id: string;
  state: string;
  activation_rule_version: number | null;
  rejection_reason: string | null;
}

/**
 * Evaluate and optionally transition a PENDING referral edge using server-side
 * Referral V1 activation authority (age, AVAILABLE AD count, OPEN CRITICAL fraud).
 */
export async function evaluateReferralActivation(
  client: PoolClient,
  input: { readonly edgeId: string },
): Promise<ReferralActivationOutcome> {
  if (typeof input.edgeId !== 'string' || input.edgeId.trim() === '') {
    throw new ReferralDomainError('INTERNAL', 'edgeId is required');
  }

  const locked = await client.query<EdgeRow>(
    `SELECT id, referred_user_id, state::text AS state,
            activation_rule_version, rejection_reason
     FROM referral_edges
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.edgeId],
  );
  const edge = locked.rows[0];
  if (edge === undefined) {
    throw new ReferralDomainError('INTERNAL', 'referral edge does not exist', {
      edgeId: input.edgeId,
    });
  }

  if (edge.state === 'ACTIVE') {
    return {
      outcome: 'ALREADY_ACTIVE',
      edgeId: edge.id,
      state: 'ACTIVE',
      activationRuleVersion: edge.activation_rule_version,
    };
  }
  if (edge.state === 'REJECTED') {
    return {
      outcome: 'ALREADY_REJECTED',
      edgeId: edge.id,
      state: 'REJECTED',
      rejectionReason: edge.rejection_reason,
      activationRuleVersion: edge.activation_rule_version,
    };
  }
  if (edge.state !== 'PENDING') {
    throw new ReferralDomainError('INTERNAL', 'referral edge state is not evaluable', {
      edgeId: edge.id,
      state: edge.state,
    });
  }

  const rule = await resolveActiveReferralRuleVersionForEvaluation(client);

  // FOR UPDATE (not FOR SHARE): serializes against concurrent fraud_flags INSERT
  // (FK takes FOR KEY SHARE on users) before age / ads / fraud reads.
  const ageRow = await client.query<{ account_age_seconds: string }>(
    `SELECT FLOOR(EXTRACT(EPOCH FROM (now() - created_at)))::bigint::text AS account_age_seconds
     FROM users
     WHERE id = $1::uuid
     FOR UPDATE`,
    [edge.referred_user_id],
  );
  if (ageRow.rows[0] === undefined) {
    throw new ReferralDomainError('INTERNAL', 'referred user does not exist', {
      referredUserId: edge.referred_user_id,
    });
  }
  const accountAgeSeconds = Number(ageRow.rows[0].account_age_seconds);
  if (!Number.isSafeInteger(accountAgeSeconds) || accountAgeSeconds < 0) {
    throw new ReferralDomainError('INTERNAL', 'invalid account age', {
      accountAgeSeconds: ageRow.rows[0].account_age_seconds,
    });
  }

  const adRow = await client.query<{ valid_ad_count: number }>(
    `SELECT COUNT(DISTINCT id)::int AS valid_ad_count
     FROM reward_events
     WHERE user_id = $1::uuid
       AND source_type = 'AD'::reward_source_type
       AND state = 'AVAILABLE'::reward_event_state`,
    [edge.referred_user_id],
  );
  const validAdCount = adRow.rows[0]?.valid_ad_count ?? 0;

  const critical = await client.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
     FROM fraud_flags
     WHERE user_id = $1::uuid
       AND severity = 'CRITICAL'::severity_level
       AND status = 'OPEN'::fraud_flag_status`,
    [edge.referred_user_id],
  );
  const openCriticalCount = critical.rows[0]?.c ?? 0;

  const requiredAccountAgeSeconds = rule.activationAccountAgeSeconds;
  const requiredValidAdCount = rule.activationValidAdCount;

  if (openCriticalCount > 0) {
    await client.query(
      `UPDATE referral_edges
       SET state = 'REJECTED'::referral_edge_state,
           rejected_at = now(),
           rejection_reason = $2,
           activation_rule_version = $3
       WHERE id = $1::uuid`,
      [edge.id, CRITICAL_FRAUD_REJECTION_REASON, rule.ruleVersion],
    );
    return {
      outcome: 'REJECTED',
      edgeId: edge.id,
      state: 'REJECTED',
      activationRuleVersion: rule.ruleVersion,
      rejectionReason: CRITICAL_FRAUD_REJECTION_REASON,
      accountAgeSeconds,
      requiredAccountAgeSeconds,
      validAdCount,
      requiredValidAdCount,
    };
  }

  const pendingReasons: Array<'ACCOUNT_AGE_PENDING' | 'VALID_AD_COUNT_PENDING'> = [];
  if (accountAgeSeconds < requiredAccountAgeSeconds) {
    pendingReasons.push('ACCOUNT_AGE_PENDING');
  }
  if (validAdCount < requiredValidAdCount) {
    pendingReasons.push('VALID_AD_COUNT_PENDING');
  }
  if (pendingReasons.length > 0) {
    return {
      outcome: 'STILL_PENDING',
      edgeId: edge.id,
      state: 'PENDING',
      reasons: pendingReasons,
      accountAgeSeconds,
      requiredAccountAgeSeconds,
      validAdCount,
      requiredValidAdCount,
    };
  }

  await client.query(
    `UPDATE referral_edges
     SET state = 'ACTIVE'::referral_edge_state,
         activated_at = now(),
         activation_rule_version = $2
     WHERE id = $1::uuid`,
    [edge.id, rule.ruleVersion],
  );

  return {
    outcome: 'ACTIVATED',
    edgeId: edge.id,
    state: 'ACTIVE',
    activationRuleVersion: rule.ruleVersion,
    accountAgeSeconds,
    requiredAccountAgeSeconds,
    validAdCount,
    requiredValidAdCount,
  };
}
