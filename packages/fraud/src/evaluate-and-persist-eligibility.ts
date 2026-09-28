import type { PoolClient } from 'pg';

import { assertSafePersistedJsonObject } from './canonical.js';
import {
  persistEligibilityDecision,
  type EligibilityActionType,
  type PersistedEligibilityDecision,
} from './eligibility-decision.js';
import {
  evaluateConfiguredEligibility,
  type ConfiguredEligibilityEvaluationResult,
  type EligibilityGateCode,
  type EligibilityGateFact,
} from './eligibility-evaluator.js';
import {
  resolveActiveEligibilityPolicyVersionForEvaluation,
  type EligibilityActionPolicyConfig,
  type ResolvedEligibilityPolicyVersion,
} from './eligibility-policy.js';
import { FraudDomainError } from './errors.js';
import {
  evaluateAndPersistRisk,
  type EvaluateAndPersistRiskResult,
} from './evaluate-and-persist.js';
import type { RiskDecisionScope } from './risk-snapshot.js';

export type DeploymentEnvironment = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';

const DEPLOYMENT_ENVIRONMENTS = new Set<string>(['LOCAL', 'DEV', 'STAGING', 'PRODUCTION']);

const UNIMPLEMENTED_GATES = new Set<EligibilityGateCode>([
  'COUNTRY_POLICY',
  'MEMBERSHIP',
  'PROVIDER_LIMIT',
]);

export interface EvaluateAndPersistEligibilityInput {
  readonly userId: string;
  readonly actionType: EligibilityActionType;
  readonly serverContext: {
    readonly deploymentEnvironment: DeploymentEnvironment;
  };
}

export interface EvaluateAndPersistEligibilityResult {
  readonly policy: ResolvedEligibilityPolicyVersion;
  readonly evaluation: ConfiguredEligibilityEvaluationResult;
  readonly decision: PersistedEligibilityDecision;
  readonly risk?: EvaluateAndPersistRiskResult;
}

type AccountStateClass =
  | 'NON_ACTIVE'
  | 'BLOCKED'
  | 'COOLDOWN'
  | 'RESTRICTED'
  | 'ACTIVE_ALLOWED';

async function collectAccountStateGate(
  client: PoolClient,
  userId: string,
): Promise<EligibilityGateFact> {
  const result = await client.query<{
    status: string;
    withdrawal_status: string;
    withdrawal_cooldown_until: Date | null;
  }>(
    `SELECT status::text AS status,
            withdrawal_status::text AS withdrawal_status,
            withdrawal_cooldown_until
     FROM users
     WHERE id = $1::uuid`,
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      'userId does not identify an existing user for ACCOUNT_STATE',
      { userId },
    );
  }

  const now = new Date();
  const cooldownActive =
    row.withdrawal_cooldown_until !== null && row.withdrawal_cooldown_until > now;

  let stateClass: AccountStateClass;
  let eligible: boolean;
  let reasonCode: string;

  if (row.status !== 'ACTIVE') {
    stateClass = 'NON_ACTIVE';
    eligible = false;
    reasonCode = 'ACCOUNT_STATE_NOT_ACTIVE';
  } else if (row.withdrawal_status === 'BLOCKED') {
    stateClass = 'BLOCKED';
    eligible = false;
    reasonCode = 'ACCOUNT_STATE_WITHDRAWAL_BLOCKED';
  } else if (cooldownActive) {
    stateClass = 'COOLDOWN';
    eligible = false;
    reasonCode = 'ACCOUNT_STATE_COOLDOWN_ACTIVE';
  } else if (row.withdrawal_status === 'RESTRICTED') {
    stateClass = 'RESTRICTED';
    eligible = true;
    reasonCode = 'ACCOUNT_STATE_RESTRICTED';
  } else {
    stateClass = 'ACTIVE_ALLOWED';
    eligible = true;
    reasonCode = 'ACCOUNT_STATE_OK';
  }

  return {
    code: 'ACCOUNT_STATE',
    eligible,
    reasonCode,
    safeDetails: {
      stateClass,
      status: row.status,
      withdrawalStatus: row.withdrawal_status,
      cooldownActive,
    },
  };
}

async function collectFeatureFlagGate(
  client: PoolClient,
  deploymentEnvironment: DeploymentEnvironment,
): Promise<EligibilityGateFact> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled
     FROM feature_flags
     WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE'
       AND environment = $1::environment_name`,
    [deploymentEnvironment],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      'WITHDRAWAL_REQUESTS_PAUSE feature flag is missing for deployment environment',
      { deploymentEnvironment },
    );
  }

  if (row.enabled === true) {
    return {
      code: 'FEATURE_FLAG',
      eligible: false,
      reasonCode: 'FEATURE_FLAG_DISABLED',
      safeDetails: {
        flagKey: 'WITHDRAWAL_REQUESTS_PAUSE',
        enabled: true,
        deploymentEnvironment,
      },
    };
  }

  return {
    code: 'FEATURE_FLAG',
    eligible: true,
    reasonCode: 'FEATURE_FLAG_OK',
    safeDetails: {
      flagKey: 'WITHDRAWAL_REQUESTS_PAUSE',
      enabled: false,
      deploymentEnvironment,
    },
  };
}

async function collectRiskPolicyGate(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly actionType: EligibilityActionType;
    readonly actionPolicy: EligibilityActionPolicyConfig;
  },
): Promise<{ fact: EligibilityGateFact; risk: EvaluateAndPersistRiskResult }> {
  const allowed = input.actionPolicy.riskAllowedActions;
  if (allowed === undefined || allowed.length === 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'RISK_POLICY gate requires riskAllowedActions on the action policy',
      { actionType: input.actionType },
    );
  }

  const risk = await evaluateAndPersistRisk(client, {
    userId: input.userId,
    decisionScope: input.actionType as RiskDecisionScope,
    safeContext: { eligibilityActionType: input.actionType },
  });

  const configuredAction = risk.evaluation.action;
  const eligible = allowed.includes(configuredAction);

  return {
    risk,
    fact: {
      code: 'RISK_POLICY',
      eligible,
      reasonCode: eligible ? 'RISK_POLICY_ALLOWED' : 'RISK_POLICY_BLOCKED',
      safeDetails: {
        configuredAction,
        riskTier: risk.evaluation.riskTier,
        score: risk.evaluation.score,
        riskRuleVersion: risk.evaluation.ruleVersion,
        riskSnapshotId: risk.snapshot.id,
        riskAllowedActions: [...allowed],
      },
    },
  };
}

/**
 * Authoritative evaluate + persist Eligibility path.
 *
 * Resolves the ACTIVE Eligibility policy from the DB using server current time
 * only (FOR SHARE), collects required gate facts from server-authoritative
 * sources, evaluates via evaluateConfiguredEligibility, then persists one
 * immutable eligibility_decisions row.
 *
 * Callers supply only userId / actionType / serverContext.deploymentEnvironment.
 * They must not supply gate facts, outcome, policy version, or risk results.
 *
 * Transaction semantics: callers MUST pass a PoolClient already bound to their
 * transaction so risk snapshot/profile + eligibility decision commit/rollback
 * together. This function does not open nested transactions and does not write
 * the ledger or mutate user status.
 */
export async function evaluateAndPersistEligibility(
  client: PoolClient,
  input: EvaluateAndPersistEligibilityInput,
): Promise<EvaluateAndPersistEligibilityResult> {
  const deploymentEnvironment = input.serverContext.deploymentEnvironment;
  if (!DEPLOYMENT_ENVIRONMENTS.has(deploymentEnvironment)) {
    throw new FraudDomainError(
      'ELIGIBILITY_DECISION_INVALID',
      'deploymentEnvironment is invalid',
      { deploymentEnvironment },
    );
  }

  const policy = await resolveActiveEligibilityPolicyVersionForEvaluation(client);
  const actionPolicy = policy.policyConfig.actions[input.actionType];
  if (actionPolicy === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_ACTION_POLICY_NOT_CONFIGURED',
      `eligibility action ${input.actionType} is not configured on this policy version`,
      { actionType: input.actionType, policyVersion: policy.policyVersion },
    );
  }

  const gateFacts: EligibilityGateFact[] = [];
  let risk: EvaluateAndPersistRiskResult | undefined;

  for (const gateCode of actionPolicy.requiredGates) {
    if (UNIMPLEMENTED_GATES.has(gateCode)) {
      throw new FraudDomainError(
        'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
        `eligibility gate ${gateCode} has no Step 11 collector authority`,
        { gateCode, actionType: input.actionType },
      );
    }

    switch (gateCode) {
      case 'ACCOUNT_STATE': {
        gateFacts.push(await collectAccountStateGate(client, input.userId));
        break;
      }
      case 'FEATURE_FLAG': {
        gateFacts.push(await collectFeatureFlagGate(client, deploymentEnvironment));
        break;
      }
      case 'RISK_POLICY': {
        const collected = await collectRiskPolicyGate(client, {
          userId: input.userId,
          actionType: input.actionType,
          actionPolicy,
        });
        gateFacts.push(collected.fact);
        risk = collected.risk;
        break;
      }
      default: {
        throw new FraudDomainError(
          'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
          `eligibility gate ${gateCode} has no collector implementation`,
          { gateCode, actionType: input.actionType },
        );
      }
    }
  }

  const evaluation = evaluateConfiguredEligibility(
    { policyVersion: policy.policyVersion, policyConfig: policy.policyConfig },
    input.actionType,
    gateFacts,
  );

  const safeInputs: Record<string, unknown> = {
    policyVersion: evaluation.policyVersion,
    actionType: input.actionType,
    gateState: evaluation.gateState,
    primaryBlockedGateCode: evaluation.primaryBlockedGateCode,
    riskRuleVersion: risk?.evaluation.ruleVersion ?? null,
    riskSnapshotId: risk?.snapshot.id ?? null,
    riskConfiguredAction: risk?.evaluation.action ?? null,
    deploymentEnvironment,
  };
  assertSafePersistedJsonObject('safeInputs', safeInputs);

  const decision = await persistEligibilityDecision(client, {
    userId: input.userId,
    actionType: input.actionType,
    outcome: evaluation.outcome,
    policyVersion: evaluation.policyVersion,
    reasonCodes: evaluation.reasonCodes,
    safeInputs,
  });

  return {
    policy,
    evaluation,
    decision,
    ...(risk !== undefined ? { risk } : {}),
  };
}
