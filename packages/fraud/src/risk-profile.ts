import type { PoolClient } from 'pg';

import { FraudDomainError } from './errors.js';
import type { RiskEvaluationResult } from './risk-evaluator.js';
import type { RiskTier } from './risk-rule.js';

export interface PersistedRiskProfile {
  readonly id: string;
  readonly userId: string;
  readonly score: number;
  readonly riskTier: RiskTier;
  readonly ruleVersion: number;
  readonly reasonCodes: readonly string[];
  readonly calculatedAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertRiskProfileFromEvaluationInput {
  readonly userId: string;
  /** Score/tier/ruleVersion/reasonCodes are taken exclusively from this evaluation. */
  readonly evaluation: RiskEvaluationResult;
  readonly calculatedAt?: Date;
}

/**
 * Internal current-profile writer.
 * Copies score/tier/ruleVersion/reasonCodes from RiskEvaluationResult only —
 * callers cannot independently invent current risk state fields.
 * Does not mutate users.status / users.withdrawal_status / ledger.
 */
export async function upsertRiskProfileFromEvaluation(
  client: PoolClient,
  input: UpsertRiskProfileFromEvaluationInput,
): Promise<PersistedRiskProfile> {
  const { evaluation } = input;
  if (!Number.isInteger(evaluation.score) || evaluation.score < 0 || evaluation.score > 100) {
    throw new FraudDomainError('RISK_PROFILE_PERSIST_FAILED', 'score must be integer 0..100');
  }
  if (!Number.isInteger(evaluation.ruleVersion) || evaluation.ruleVersion <= 0) {
    throw new FraudDomainError('RISK_PROFILE_PERSIST_FAILED', 'ruleVersion must be positive integer');
  }
  if (evaluation.reasonCodes.length === 0) {
    throw new FraudDomainError(
      'RISK_PROFILE_PERSIST_FAILED',
      'evaluation.reasonCodes must be non-empty',
    );
  }

  const calculatedAt = input.calculatedAt ?? new Date();
  const result = await client.query<{
    id: string;
    score: number;
    risk_tier: RiskTier;
    rule_version: number;
    reason_codes: string[];
    calculated_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO risk_profiles (
       user_id, score, risk_tier, rule_version, reason_codes, calculated_at
     ) VALUES (
       $1::uuid, $2, $3::risk_tier, $4, $5::text[], $6::timestamptz
     )
     ON CONFLICT (user_id) DO UPDATE SET
       score = EXCLUDED.score,
       risk_tier = EXCLUDED.risk_tier,
       rule_version = EXCLUDED.rule_version,
       reason_codes = EXCLUDED.reason_codes,
       calculated_at = EXCLUDED.calculated_at,
       updated_at = now()
     RETURNING id, score, risk_tier, rule_version, reason_codes, calculated_at, updated_at`,
    [
      input.userId,
      evaluation.score,
      evaluation.riskTier,
      evaluation.ruleVersion,
      evaluation.reasonCodes,
      calculatedAt.toISOString(),
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError('RISK_PROFILE_PERSIST_FAILED', 'risk profile upsert returned no row');
  }

  return {
    id: row.id,
    userId: input.userId,
    score: row.score,
    riskTier: row.risk_tier,
    ruleVersion: row.rule_version,
    reasonCodes: row.reason_codes,
    calculatedAt: row.calculated_at,
    updatedAt: row.updated_at,
  };
}
