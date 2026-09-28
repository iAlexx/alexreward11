import {
  FraudDomainError,
  evaluateAndPersistEligibility,
  type DeploymentEnvironment,
  type EvaluateAndPersistEligibilityResult,
} from '@alex-rewards/fraud';
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

/**
 * Map FraudDomainError → WithdrawalDomainError (fail-closed).
 * Missing ACTIVE Risk / Eligibility policies become typed policy-required codes.
 */
export function mapFraudErrorToWithdrawal(error: unknown): WithdrawalDomainError {
  if (error instanceof WithdrawalDomainError) {
    return error;
  }
  if (!(error instanceof FraudDomainError)) {
    return new WithdrawalDomainError(
      'INTERNAL',
      'Unexpected eligibility/risk failure',
      { cause: error },
    );
  }

  switch (error.code) {
    case 'RISK_RULE_NOT_CONFIGURED':
      return new WithdrawalDomainError(
        'RISK_POLICY_REQUIRED',
        'Active risk policy is required',
        error.details === undefined
          ? { cause: error }
          : { cause: error, details: error.details },
      );
    case 'ELIGIBILITY_POLICY_NOT_CONFIGURED':
    case 'ELIGIBILITY_ACTION_POLICY_NOT_CONFIGURED':
      return new WithdrawalDomainError(
        'OWNER_POLICY_REQUIRED',
        'Active eligibility policy is required',
        error.details === undefined
          ? { cause: error }
          : { cause: error, details: error.details },
      );
    case 'RISK_RULE_CONFIG_INVALID':
    case 'RISK_RULE_INTEGRITY':
    case 'ELIGIBILITY_POLICY_CONFIG_INVALID':
    case 'ELIGIBILITY_POLICY_INTEGRITY':
    case 'ELIGIBILITY_GATE_SET_MISMATCH':
    case 'ELIGIBILITY_EVALUATION_AMBIGUOUS':
      return new WithdrawalDomainError(
        'CONFIG',
        error.message,
        error.details === undefined
          ? { cause: error }
          : { cause: error, details: error.details },
      );
    default:
      return new WithdrawalDomainError(
        'CONFIG',
        error.message,
        error.details === undefined
          ? { cause: error }
          : { cause: error, details: error.details },
      );
  }
}

/**
 * Preflight Eligibility (+ nested Risk when RISK_POLICY gate runs).
 * Persists evidence via the caller's transaction. Does NOT create withdrawals
 * or write the ledger.
 */
export async function runWithdrawalEligibilityPreflight(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly deploymentEnvironment: DeploymentEnvironment;
  },
): Promise<EvaluateAndPersistEligibilityResult> {
  try {
    return await evaluateAndPersistEligibility(client, {
      userId: input.userId,
      actionType: 'WITHDRAWAL_REQUEST',
      serverContext: { deploymentEnvironment: input.deploymentEnvironment },
    });
  } catch (error) {
    throw mapFraudErrorToWithdrawal(error);
  }
}

export function isEligibilityOutcomeEligible(
  outcome: EvaluateAndPersistEligibilityResult['evaluation']['outcome'],
): boolean {
  return outcome === 'ELIGIBLE';
}
