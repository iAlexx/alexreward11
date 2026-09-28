import { assertSafePersistedJsonObject } from './canonical.js';
import type { EligibilityActionType, EligibilityOutcome } from './eligibility-decision.js';
import type { EligibilityPolicyConfig, EligibilityPolicyVersion } from './eligibility-policy.js';
import { FraudDomainError } from './errors.js';

/**
 * Typed Eligibility gate codes (Step 8).
 * Facts only — no business thresholds, collectors, or DB authority.
 */
export const ELIGIBILITY_GATE_CODES = [
  'ACCOUNT_STATE',
  'RISK_POLICY',
  'PROVIDER_LIMIT',
  'COUNTRY_POLICY',
  'MEMBERSHIP',
  'FEATURE_FLAG',
] as const;

export type EligibilityGateCode = (typeof ELIGIBILITY_GATE_CODES)[number];

const GATE_CODE_SET = new Set<string>(ELIGIBILITY_GATE_CODES);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Structural outcome mapping — not caller-overridable, not a precedence policy. */
const GATE_BLOCKED_OUTCOME = {
  ACCOUNT_STATE: 'INELIGIBLE_ACCOUNT_STATE',
  RISK_POLICY: 'INELIGIBLE_RISK_POLICY',
  PROVIDER_LIMIT: 'INELIGIBLE_PROVIDER_LIMIT',
  COUNTRY_POLICY: 'INELIGIBLE_COUNTRY',
  MEMBERSHIP: 'INELIGIBLE_MEMBERSHIP',
  FEATURE_FLAG: 'INELIGIBLE_FEATURE_DISABLED',
} as const satisfies Record<EligibilityGateCode, Exclude<EligibilityOutcome, 'ELIGIBLE'>>;

type BlockedEligibilityOutcome = (typeof GATE_BLOCKED_OUTCOME)[EligibilityGateCode];

export interface EligibilityGateFact {
  readonly code: EligibilityGateCode;
  readonly eligible: boolean;
  readonly reasonCode: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
}

export interface EligibilityGateStateEntry {
  readonly code: EligibilityGateCode;
  readonly eligible: boolean;
  readonly reasonCode: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
}

export interface EligibilityEvaluationResult {
  readonly policyVersion: number;
  readonly outcome: EligibilityOutcome;
  readonly reasonCodes: readonly string[];
  readonly gateState: readonly EligibilityGateStateEntry[];
}

/** Narrow policy binding — evaluator never invents or resolves policy versions. */
export type EligibilityEvaluatorPolicy = Pick<EligibilityPolicyVersion, 'policyVersion'>;

const ALL_PASS_REASON = 'ELIGIBLE_ALL_EVALUATED_GATES_PASSED';

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function validateGateFact(fact: EligibilityGateFact, index: number): void {
  if (!GATE_CODE_SET.has(fact.code)) {
    throw new FraudDomainError('ELIGIBILITY_GATE_INVALID', `gate code is invalid at index ${index}`, {
      index,
      code: fact.code,
    });
  }
  if (typeof fact.eligible !== 'boolean') {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_INVALID',
      `eligible must be boolean at index ${index}`,
      { index, code: fact.code },
    );
  }
  if (typeof fact.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(fact.reasonCode)) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_INVALID',
      `reasonCode is invalid at index ${index}`,
      { index, code: fact.code, reasonCode: fact.reasonCode },
    );
  }
  if (fact.safeDetails !== undefined) {
    assertSafePersistedJsonObject(`gateFacts[${index}].safeDetails`, fact.safeDetails);
  }
}

/**
 * Pure deterministic Eligibility evaluator over already-resolved typed gate facts.
 *
 * Does NOT collect facts, persist decisions, invent precedence, or access the DB.
 * Multiple distinct blocked outcome classes => ELIGIBILITY_EVALUATION_AMBIGUOUS.
 */
export function evaluateEligibilityGates(
  policy: EligibilityEvaluatorPolicy,
  gateFacts: readonly EligibilityGateFact[],
): EligibilityEvaluationResult {
  if (!Number.isInteger(policy.policyVersion) || policy.policyVersion <= 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_INVALID',
      'policy.policyVersion must be a positive integer',
      { policyVersion: policy.policyVersion },
    );
  }

  for (let i = 0; i < gateFacts.length; i += 1) {
    validateGateFact(gateFacts[i]!, i);
  }

  const seen = new Set<EligibilityGateCode>();
  for (const fact of gateFacts) {
    if (seen.has(fact.code)) {
      throw new FraudDomainError(
        'ELIGIBILITY_GATE_DUPLICATE',
        `duplicate eligibility gate code ${fact.code}`,
        { code: fact.code },
      );
    }
    seen.add(fact.code);
  }

  const canonical = [...gateFacts].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );

  const gateState: EligibilityGateStateEntry[] = canonical.map((fact) => {
    const entry: EligibilityGateStateEntry = {
      code: fact.code,
      eligible: fact.eligible,
      reasonCode: fact.reasonCode,
    };
    if (fact.safeDetails !== undefined) {
      return { ...entry, safeDetails: fact.safeDetails };
    }
    return entry;
  });

  const failures = canonical.filter((fact) => fact.eligible === false);

  if (failures.length === 0) {
    return {
      policyVersion: policy.policyVersion,
      outcome: 'ELIGIBLE',
      reasonCodes: [ALL_PASS_REASON],
      gateState,
    };
  }

  const blockedOutcomes = sortStrings([
    ...new Set(failures.map((fact) => GATE_BLOCKED_OUTCOME[fact.code] as string)),
  ]) as BlockedEligibilityOutcome[];

  if (blockedOutcomes.length > 1) {
    throw new FraudDomainError(
      'ELIGIBILITY_EVALUATION_AMBIGUOUS',
      'Multiple distinct ineligible outcome classes; no Owner-approved precedence',
      {
        blockedOutcomes,
        failedGateCodes: sortStrings(failures.map((fact) => fact.code)),
      },
    );
  }

  const outcome = blockedOutcomes[0]!;
  const reasonCodes = sortStrings([...new Set(failures.map((fact) => fact.reasonCode))]);

  return {
    policyVersion: policy.policyVersion,
    outcome,
    reasonCodes,
    gateState,
  };
}

export interface ConfiguredEligibilityEvaluationResult {
  readonly policyVersion: number;
  readonly actionType: EligibilityActionType;
  readonly outcome: EligibilityOutcome;
  readonly reasonCodes: readonly string[];
  readonly primaryBlockedGateCode: EligibilityGateCode | null;
  readonly gateState: readonly EligibilityGateStateEntry[];
}

export interface ConfiguredEligibilityEvaluatorPolicy {
  readonly policyVersion: number;
  readonly policyConfig: EligibilityPolicyConfig;
}

/**
 * Pure configured Eligibility evaluator: required-gate completeness + versioned precedence.
 * Does NOT collect facts, persist, invent business thresholds, or access the DB.
 */
export function evaluateConfiguredEligibility(
  policy: ConfiguredEligibilityEvaluatorPolicy,
  actionType: EligibilityActionType,
  gateFacts: readonly EligibilityGateFact[],
): ConfiguredEligibilityEvaluationResult {
  if (!Number.isInteger(policy.policyVersion) || policy.policyVersion <= 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_INVALID',
      'policy.policyVersion must be a positive integer',
      { policyVersion: policy.policyVersion },
    );
  }

  const actionPolicy = policy.policyConfig.actions[actionType];
  if (actionPolicy === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_ACTION_POLICY_NOT_CONFIGURED',
      `eligibility action ${actionType} is not configured on this policy version`,
      { actionType, policyVersion: policy.policyVersion },
    );
  }

  for (let i = 0; i < gateFacts.length; i += 1) {
    validateGateFact(gateFacts[i]!, i);
  }

  const seen = new Set<EligibilityGateCode>();
  for (const fact of gateFacts) {
    if (seen.has(fact.code)) {
      throw new FraudDomainError(
        'ELIGIBILITY_GATE_DUPLICATE',
        `duplicate eligibility gate code ${fact.code}`,
        { code: fact.code },
      );
    }
    seen.add(fact.code);
  }

  const requiredGateCodes = sortStrings([...actionPolicy.requiredGates]);
  const providedGateCodes = sortStrings(gateFacts.map((f) => f.code));
  const requiredSet = new Set(actionPolicy.requiredGates);
  const providedSet = new Set(gateFacts.map((f) => f.code));
  const missingGateCodes = sortStrings(
    actionPolicy.requiredGates.filter((code) => !providedSet.has(code)),
  );
  const extraGateCodes = sortStrings(gateFacts.map((f) => f.code).filter((c) => !requiredSet.has(c)));

  if (missingGateCodes.length > 0 || extraGateCodes.length > 0) {
    throw new FraudDomainError(
      'ELIGIBILITY_GATE_SET_MISMATCH',
      'supplied gate facts must equal exactly the action requiredGates set',
      {
        requiredGateCodes,
        providedGateCodes,
        missingGateCodes,
        extraGateCodes,
      },
    );
  }

  const canonical = [...gateFacts].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );

  const gateState: EligibilityGateStateEntry[] = canonical.map((fact) => {
    const entry: EligibilityGateStateEntry = {
      code: fact.code,
      eligible: fact.eligible,
      reasonCode: fact.reasonCode,
    };
    if (fact.safeDetails !== undefined) {
      return { ...entry, safeDetails: fact.safeDetails };
    }
    return entry;
  });

  const byCode = new Map(canonical.map((fact) => [fact.code, fact]));
  const failures = canonical.filter((fact) => fact.eligible === false);

  if (failures.length === 0) {
    return {
      policyVersion: policy.policyVersion,
      actionType,
      outcome: 'ELIGIBLE',
      reasonCodes: [ALL_PASS_REASON],
      primaryBlockedGateCode: null,
      gateState,
    };
  }

  let primary: EligibilityGateFact | undefined;
  for (const code of actionPolicy.precedence) {
    const fact = byCode.get(code);
    if (fact !== undefined && fact.eligible === false) {
      primary = fact;
      break;
    }
  }
  if (primary === undefined) {
    throw new FraudDomainError(
      'ELIGIBILITY_POLICY_CONFIG_INVALID',
      'precedence did not select a failed required gate',
      { actionType, policyVersion: policy.policyVersion },
    );
  }

  return {
    policyVersion: policy.policyVersion,
    actionType,
    outcome: GATE_BLOCKED_OUTCOME[primary.code],
    reasonCodes: sortStrings([...new Set(failures.map((f) => f.reasonCode))]),
    primaryBlockedGateCode: primary.code,
    gateState,
  };
}
