import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  assertSafePersistedJsonObject,
  canonicalizeForDigest,
} from './canonical.js';
import { FraudDomainError } from './errors.js';
import { loadEligibilityPolicyVersionByNumber } from './eligibility-policy.js';

export const ELIGIBILITY_ACTION_TYPES = [
  'AD_SESSION_START',
  'WITHDRAWAL_REQUEST',
  'MISSION_CLAIM',
  'TASK_CLAIM',
  'REFERRAL_ACTIVATION',
  'MEMBERSHIP_CLAIM',
] as const;

export type EligibilityActionType = (typeof ELIGIBILITY_ACTION_TYPES)[number];

export const ELIGIBILITY_OUTCOMES = [
  'ELIGIBLE',
  'INELIGIBLE_PROVIDER_LIMIT',
  'INELIGIBLE_COUNTRY',
  'INELIGIBLE_ACCOUNT_STATE',
  'INELIGIBLE_RISK_POLICY',
  'INELIGIBLE_MEMBERSHIP',
  'INELIGIBLE_FEATURE_DISABLED',
] as const;

export type EligibilityOutcome = (typeof ELIGIBILITY_OUTCOMES)[number];

const ACTION_SET = new Set<string>(ELIGIBILITY_ACTION_TYPES);
const OUTCOME_SET = new Set<string>(ELIGIBILITY_OUTCOMES);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface PersistEligibilityDecisionInput {
  readonly userId: string;
  readonly actionType: EligibilityActionType;
  readonly outcome: EligibilityOutcome;
  /** Must reference an existing eligibility_policy_versions.policy_version. */
  readonly policyVersion: number;
  readonly reasonCodes: readonly string[];
  readonly safeInputs: Readonly<Record<string, unknown>>;
  readonly providerId?: string | null;
  readonly adSessionId?: string | null;
  readonly missionVersionId?: string | null;
  /** Optional future validity boundary; not invented by this primitive. */
  readonly expiresAt?: Date | null;
}

export interface PersistedEligibilityDecision {
  readonly id: string;
  readonly userId: string;
  readonly actionType: EligibilityActionType;
  readonly outcome: EligibilityOutcome;
  readonly policyVersion: number;
  readonly reasonCodes: readonly string[];
  readonly inputsDigest: string;
  readonly safeInputs: Readonly<Record<string, unknown>>;
  readonly providerId: string | null;
  readonly adSessionId: string | null;
  readonly missionVersionId: string | null;
  readonly decidedAt: Date;
  readonly expiresAt: Date | null;
}

export interface EligibilityDigestInput {
  readonly policyVersion: number;
  readonly userId: string;
  readonly actionType: EligibilityActionType;
  readonly providerId: string | null;
  readonly adSessionId: string | null;
  readonly missionVersionId: string | null;
  readonly safeInputs: Readonly<Record<string, unknown>>;
}

/**
 * Deterministic SHA-256 digest for eligibility decision inputs.
 * Caller has no digest authority — persistEligibilityDecision computes this internally.
 */
export function computeEligibilityInputsDigest(input: EligibilityDigestInput): string {
  if (!Number.isInteger(input.policyVersion) || input.policyVersion <= 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_DECISION_INVALID',
      'policyVersion must be a positive integer',
    );
  }
  assertSafePersistedJsonObject('safeInputs', input.safeInputs);
  const payload = canonicalizeForDigest({
    policyVersion: input.policyVersion,
    userId: input.userId,
    actionType: input.actionType,
    providerId: input.providerId,
    adSessionId: input.adSessionId,
    missionVersionId: input.missionVersionId,
    safeInputs: input.safeInputs,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function normalizeReasonCodes(codes: readonly string[]): readonly string[] {
  if (codes.length === 0) {
    throw new FraudDomainError('ELIGIBILITY_DECISION_INVALID', 'reasonCodes must be non-empty');
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const code of codes) {
    if (!REASON_CODE_PATTERN.test(code)) {
      throw new FraudDomainError('ELIGIBILITY_DECISION_INVALID', `invalid reason code ${code}`, {
        code,
      });
    }
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }
  }
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

/**
 * Persist an already-produced eligibility decision as immutable audit evidence.
 *
 * Does NOT evaluate eligibility, invent country authority, mutate Risk/Trust,
 * write the ledger, or authorize money movement. ELIGIBLE is availability only.
 */
export async function persistEligibilityDecision(
  client: PoolClient,
  input: PersistEligibilityDecisionInput,
): Promise<PersistedEligibilityDecision> {
  if (!ACTION_SET.has(input.actionType)) {
    throw new FraudDomainError('ELIGIBILITY_DECISION_INVALID', 'actionType is invalid', {
      actionType: input.actionType,
    });
  }
  if (!OUTCOME_SET.has(input.outcome)) {
    throw new FraudDomainError('ELIGIBILITY_DECISION_INVALID', 'outcome is invalid', {
      outcome: input.outcome,
    });
  }

  const reasonCodes = normalizeReasonCodes(input.reasonCodes);
  assertSafePersistedJsonObject('safeInputs', input.safeInputs);

  const policy = await loadEligibilityPolicyVersionByNumber(client, input.policyVersion);
  if (policy.policyConfig === null) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'eligibility policy version has no usable policy_config',
      { policyVersion: policy.policyVersion },
    );
  }

  const providerId = input.providerId ?? null;
  const adSessionId = input.adSessionId ?? null;
  const missionVersionId = input.missionVersionId ?? null;
  const expiresAt = input.expiresAt ?? null;

  const inputsDigest = computeEligibilityInputsDigest({
    policyVersion: policy.policyVersion,
    userId: input.userId,
    actionType: input.actionType,
    providerId,
    adSessionId,
    missionVersionId,
    safeInputs: input.safeInputs,
  });

  const result = await client.query<{
    id: string;
    decided_at: Date;
    expires_at: Date | null;
  }>(
    `INSERT INTO eligibility_decisions (
       user_id, action_type, outcome, provider_id, ad_session_id, mission_version_id,
       reason_codes, policy_version, inputs_digest, safe_inputs, expires_at
     ) VALUES (
       $1::uuid, $2::eligibility_action_type, $3::eligibility_outcome,
       $4::uuid, $5::uuid, $6::uuid,
       $7::text[], $8, $9, $10::jsonb, $11::timestamptz
     )
     RETURNING id, decided_at, expires_at`,
    [
      input.userId,
      input.actionType,
      input.outcome,
      providerId,
      adSessionId,
      missionVersionId,
      reasonCodes,
      policy.policyVersion,
      inputsDigest,
      JSON.stringify(input.safeInputs),
      expiresAt === null ? null : expiresAt.toISOString(),
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_DECISION_PERSIST_FAILED',
      'eligibility decision insert returned no row',
    );
  }

  return {
    id: row.id,
    userId: input.userId,
    actionType: input.actionType,
    outcome: input.outcome,
    policyVersion: policy.policyVersion,
    reasonCodes,
    inputsDigest,
    safeInputs: input.safeInputs,
    providerId,
    adSessionId,
    missionVersionId,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
  };
}
