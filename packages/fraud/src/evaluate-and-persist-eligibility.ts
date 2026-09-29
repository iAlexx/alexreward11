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

/** Gates still without any collector (mission collectors cover MEMBERSHIP / COUNTRY_POLICY). */
const UNIMPLEMENTED_GATES = new Set<EligibilityGateCode>(['PROVIDER_LIMIT']);

const EXCLUSIVE_MISSION_ACCESS_CODE = 'EXCLUSIVE_MISSION_ACCESS';

export interface EvaluateAndPersistEligibilityInput {
  readonly userId: string;
  readonly actionType: EligibilityActionType;
  readonly serverContext: {
    readonly deploymentEnvironment: DeploymentEnvironment;
  };
  /**
   * Server-only mission resource context for MISSION_CLAIM (and any gate that
   * needs mission version authority). Callers must never accept this from clients
   * as an independent authority — load it from locked mission progress/version.
   */
  readonly missionVersionId?: string | null;
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

interface MissionVersionEligibilityContext {
  readonly id: string;
  readonly requiredMembershipPlanId: string | null;
  readonly rewardRuleId: string | null;
  readonly countryGroup: string | null;
}

async function loadMissionVersionEligibilityContext(
  client: PoolClient,
  missionVersionId: string,
): Promise<MissionVersionEligibilityContext> {
  const result = await client.query<{
    id: string;
    required_membership_plan_id: string | null;
    reward_rule_id: string | null;
    country_group: string | null;
  }>(
    `SELECT id,
            required_membership_plan_id,
            reward_rule_id,
            NULLIF(btrim(eligibility_policy->>'countryGroup'), '') AS country_group
     FROM mission_versions
     WHERE id = $1::uuid
     FOR SHARE`,
    [missionVersionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      'missionVersionId does not identify an existing mission version',
      { missionVersionId },
    );
  }
  return {
    id: row.id,
    requiredMembershipPlanId: row.required_membership_plan_id,
    rewardRuleId: row.reward_rule_id,
    countryGroup: row.country_group,
  };
}

async function requireMissionContext(
  client: PoolClient,
  input: {
    readonly actionType: EligibilityActionType;
    readonly gateCode: EligibilityGateCode;
    readonly missionVersionId: string | null | undefined;
  },
): Promise<MissionVersionEligibilityContext> {
  if (input.missionVersionId === null || input.missionVersionId === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      `eligibility gate ${input.gateCode} requires server missionVersionId resource context`,
      { gateCode: input.gateCode, actionType: input.actionType },
    );
  }
  return loadMissionVersionEligibilityContext(client, input.missionVersionId);
}

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
  input: {
    readonly deploymentEnvironment: DeploymentEnvironment;
    readonly actionType: EligibilityActionType;
    readonly missionVersionId: string | null | undefined;
  },
): Promise<EligibilityGateFact> {
  if (input.actionType === 'MISSION_CLAIM') {
    const mission = await requireMissionContext(client, {
      actionType: input.actionType,
      gateCode: 'FEATURE_FLAG',
      missionVersionId: input.missionVersionId,
    });

    // Non-monetary missions (null reward_rule_id) do not require MISSION_REWARD_PAUSE.
    if (mission.rewardRuleId === null) {
      return {
        code: 'FEATURE_FLAG',
        eligible: true,
        reasonCode: 'FEATURE_FLAG_NOT_REQUIRED',
        safeDetails: {
          flagKey: 'MISSION_REWARD_PAUSE',
          monetary: false,
          deploymentEnvironment: input.deploymentEnvironment,
        },
      };
    }

    const result = await client.query<{ enabled: boolean }>(
      `SELECT enabled
       FROM feature_flags
       WHERE flag_key = 'MISSION_REWARD_PAUSE'
         AND environment = $1::environment_name`,
      [input.deploymentEnvironment],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new FraudDomainError(
        'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
        'MISSION_REWARD_PAUSE feature flag is missing for deployment environment',
        { deploymentEnvironment: input.deploymentEnvironment },
      );
    }

    if (row.enabled === true) {
      return {
        code: 'FEATURE_FLAG',
        eligible: false,
        reasonCode: 'FEATURE_FLAG_DISABLED',
        safeDetails: {
          flagKey: 'MISSION_REWARD_PAUSE',
          enabled: true,
          monetary: true,
          deploymentEnvironment: input.deploymentEnvironment,
        },
      };
    }

    return {
      code: 'FEATURE_FLAG',
      eligible: true,
      reasonCode: 'FEATURE_FLAG_OK',
      safeDetails: {
        flagKey: 'MISSION_REWARD_PAUSE',
        enabled: false,
        monetary: true,
        deploymentEnvironment: input.deploymentEnvironment,
      },
    };
  }

  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled
     FROM feature_flags
     WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE'
       AND environment = $1::environment_name`,
    [input.deploymentEnvironment],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      'WITHDRAWAL_REQUESTS_PAUSE feature flag is missing for deployment environment',
      { deploymentEnvironment: input.deploymentEnvironment },
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
        deploymentEnvironment: input.deploymentEnvironment,
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
      deploymentEnvironment: input.deploymentEnvironment,
    },
  };
}

async function collectMembershipGate(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly actionType: EligibilityActionType;
    readonly missionVersionId: string | null | undefined;
  },
): Promise<EligibilityGateFact> {
  const mission = await requireMissionContext(client, {
    actionType: input.actionType,
    gateCode: 'MEMBERSHIP',
    missionVersionId: input.missionVersionId,
  });

  if (mission.requiredMembershipPlanId === null) {
    return {
      code: 'MEMBERSHIP',
      eligible: true,
      reasonCode: 'MEMBERSHIP_NOT_REQUIRED',
      safeDetails: {
        requiredMembershipPlanId: null,
      },
    };
  }

  const nowResult = await client.query<{ now: Date }>(`SELECT now() AS now`);
  const at = nowResult.rows[0]?.now;
  if (at === undefined) {
    throw new FraudDomainError('INTERNAL', 'failed to read server now() for MEMBERSHIP gate');
  }

  const membership = await client.query<{
    user_membership_id: string;
    entitlement_rule_version_id: string;
  }>(
    `SELECT um.id AS user_membership_id,
            mbr.id AS entitlement_rule_version_id
     FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.membership_plan_id
     JOIN membership_plan_entitlements mpe ON mpe.membership_plan_id = mp.id
     JOIN entitlements e ON e.id = mpe.entitlement_id
     JOIN membership_benefit_rule_versions mbr
       ON mbr.id = mpe.rule_version_id
      AND mbr.entitlement_id = mpe.entitlement_id
      AND (mbr.membership_plan_id IS NULL OR mbr.membership_plan_id = mp.id)
     WHERE um.user_id = $1::uuid
       AND um.membership_plan_id = $2::uuid
       AND um.status = 'ACTIVE'
       AND (um.expires_at IS NULL OR um.expires_at > $3::timestamptz)
       AND um.revoked_at IS NULL
       AND mp.status = 'ACTIVE'
       AND mpe.status = 'ACTIVE'
       AND mpe.valid_from <= $3::timestamptz
       AND (mpe.valid_to IS NULL OR mpe.valid_to > $3::timestamptz)
       AND e.code = $4
       AND e.value_type = 'BOOLEAN'
       AND mbr.status = 'ACTIVE'
       AND mbr.effective_from <= $3::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $3::timestamptz)
       AND mbr.value_boolean IS TRUE
     FOR SHARE OF um, mp, mpe, mbr`,
    [
      input.userId,
      mission.requiredMembershipPlanId,
      at.toISOString(),
      EXCLUSIVE_MISSION_ACCESS_CODE,
    ],
  );

  if (membership.rows.length === 0) {
    // Distinguish missing membership vs missing entitlement for audit, without
    // special-casing Founder plan codes.
    const planMembership = await client.query<{ id: string }>(
      `SELECT um.id
       FROM user_memberships um
       WHERE um.user_id = $1::uuid
         AND um.membership_plan_id = $2::uuid
         AND um.status = 'ACTIVE'
         AND (um.expires_at IS NULL OR um.expires_at > $3::timestamptz)
         AND um.revoked_at IS NULL
       FOR SHARE`,
      [input.userId, mission.requiredMembershipPlanId, at.toISOString()],
    );
    const reasonCode =
      planMembership.rows.length === 0
        ? 'MEMBERSHIP_PLAN_NOT_ACTIVE'
        : 'EXCLUSIVE_MISSION_ACCESS_MISSING';
    return {
      code: 'MEMBERSHIP',
      eligible: false,
      reasonCode,
      safeDetails: {
        requiredMembershipPlanId: mission.requiredMembershipPlanId,
        entitlementCode: EXCLUSIVE_MISSION_ACCESS_CODE,
      },
    };
  }

  if (membership.rows.length > 1) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
      'Ambiguous EXCLUSIVE_MISSION_ACCESS entitlement mappings for required plan',
      {
        requiredMembershipPlanId: mission.requiredMembershipPlanId,
        candidateCount: membership.rows.length,
      },
    );
  }

  const row = membership.rows[0]!;
  return {
    code: 'MEMBERSHIP',
    eligible: true,
    reasonCode: 'MEMBERSHIP_OK',
    safeDetails: {
      requiredMembershipPlanId: mission.requiredMembershipPlanId,
      userMembershipId: row.user_membership_id,
      entitlementRuleVersionId: row.entitlement_rule_version_id,
      entitlementCode: EXCLUSIVE_MISSION_ACCESS_CODE,
    },
  };
}

async function collectCountryPolicyGate(
  client: PoolClient,
  input: {
    readonly actionType: EligibilityActionType;
    readonly missionVersionId: string | null | undefined;
  },
): Promise<EligibilityGateFact> {
  const mission = await requireMissionContext(client, {
    actionType: input.actionType,
    gateCode: 'COUNTRY_POLICY',
    missionVersionId: input.missionVersionId,
  });

  if (mission.countryGroup === null) {
    return {
      code: 'COUNTRY_POLICY',
      eligible: true,
      reasonCode: 'COUNTRY_POLICY_NOT_REQUIRED',
      safeDetails: {
        countryGroup: null,
      },
    };
  }

  // No approved authoritative country collector exists. Fail closed — do not
  // infer from IP, Telegram language, locale, or profile.
  throw new FraudDomainError(
    'ELIGIBILITY_GATE_SOURCE_UNAVAILABLE',
    'COUNTRY_AUTHORITY_UNAVAILABLE: mission countryGroup is set but no country collector is approved',
    {
      gateCode: 'COUNTRY_POLICY',
      reasonCode: 'COUNTRY_AUTHORITY_UNAVAILABLE',
      countryGroup: mission.countryGroup,
      missionVersionId: mission.id,
    },
  );
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
 * Callers supply only userId / actionType / serverContext.deploymentEnvironment
 * and optional server-derived missionVersionId. They must not supply gate facts,
 * outcome, policy version, or risk results.
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

  const missionVersionId = input.missionVersionId ?? null;

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
        `eligibility gate ${gateCode} has no collector authority`,
        { gateCode, actionType: input.actionType },
      );
    }

    switch (gateCode) {
      case 'ACCOUNT_STATE': {
        gateFacts.push(await collectAccountStateGate(client, input.userId));
        break;
      }
      case 'FEATURE_FLAG': {
        gateFacts.push(
          await collectFeatureFlagGate(client, {
            deploymentEnvironment,
            actionType: input.actionType,
            missionVersionId,
          }),
        );
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
      case 'MEMBERSHIP': {
        gateFacts.push(
          await collectMembershipGate(client, {
            userId: input.userId,
            actionType: input.actionType,
            missionVersionId,
          }),
        );
        break;
      }
      case 'COUNTRY_POLICY': {
        gateFacts.push(
          await collectCountryPolicyGate(client, {
            actionType: input.actionType,
            missionVersionId,
          }),
        );
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
    missionVersionId,
  };
  assertSafePersistedJsonObject('safeInputs', safeInputs);

  const decision = await persistEligibilityDecision(client, {
    userId: input.userId,
    actionType: input.actionType,
    outcome: evaluation.outcome,
    policyVersion: evaluation.policyVersion,
    reasonCodes: evaluation.reasonCodes,
    safeInputs,
    missionVersionId,
  });

  return {
    policy,
    evaluation,
    decision,
    ...(risk !== undefined ? { risk } : {}),
  };
}
