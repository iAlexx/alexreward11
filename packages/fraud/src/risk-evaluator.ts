import { assertSafePersistedJsonObject } from './canonical.js';
import { FraudDomainError } from './errors.js';
import {
  isValidSignalCode,
  type RiskActionCode,
  type RiskRuleVersion,
  type RiskTier,
} from './risk-rule.js';

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Server-produced signal fact.
 * Caller supplies code/active/reason only — never weight, score, tier, or action.
 */
export interface RiskSignalFact {
  readonly code: string;
  readonly active: boolean;
  readonly reasonCode: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
}

export interface RiskSignalContribution {
  readonly code: string;
  readonly active: boolean;
  readonly configuredWeight: number;
  readonly contribution: number;
}

export interface RiskEvaluationResult {
  readonly score: number;
  readonly riskTier: RiskTier;
  readonly action: RiskActionCode;
  readonly activeSignals: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly contributions: readonly RiskSignalContribution[];
  /** Evaluator never executes adverse actions; callers must not treat this as a ban. */
  readonly neverAutoBan: true;
  readonly ruleVersion: number;
}

function assertReasonCode(code: string): string {
  if (!REASON_CODE_PATTERN.test(code)) {
    throw new FraudDomainError('RISK_SIGNAL_INVALID', `invalid reasonCode ${code}`, { code });
  }
  return code;
}

function assertSignalFact(fact: RiskSignalFact): RiskSignalFact {
  if (!isValidSignalCode(fact.code)) {
    throw new FraudDomainError('RISK_SIGNAL_INVALID', `invalid signal code ${fact.code}`, {
      code: fact.code,
    });
  }
  if (typeof fact.active !== 'boolean') {
    throw new FraudDomainError('RISK_SIGNAL_INVALID', 'signal active must be boolean', {
      code: fact.code,
    });
  }
  assertReasonCode(fact.reasonCode);
  if (fact.safeDetails !== undefined) {
    assertSafePersistedJsonObject(`signal.${fact.code}.safeDetails`, fact.safeDetails);
  }
  return fact;
}

function resolveRiskTier(
  score: number,
  thresholds: RiskRuleVersion['thresholds'],
): RiskTier {
  if (score <= thresholds.lowMax) return 'LOW';
  if (score <= thresholds.mediumMax) return 'MEDIUM';
  if (score <= thresholds.highMax) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Deterministic V1 multi-signal risk evaluation.
 *
 * score = min(sum(active configured weights), 100) using integer arithmetic only.
 * Tier boundaries and actions come exclusively from the resolved rule.
 * Does not execute actions, mutate accounts, or write the ledger.
 */
export function evaluateRiskSignals(
  rule: RiskRuleVersion,
  signalFacts: readonly RiskSignalFact[],
): RiskEvaluationResult {
  const seen = new Set<string>();
  const validated: RiskSignalFact[] = [];

  for (const raw of signalFacts) {
    const fact = assertSignalFact(raw);
    if (seen.has(fact.code)) {
      throw new FraudDomainError(
        'RISK_SIGNAL_DUPLICATE',
        `duplicate signal code ${fact.code}`,
        { code: fact.code },
      );
    }
    seen.add(fact.code);

    const configuredWeight = rule.signalWeights[fact.code];
    if (configuredWeight === undefined) {
      throw new FraudDomainError(
        'RISK_SIGNAL_UNCONFIGURED',
        `signal code ${fact.code} is not present in rule signal_weights`,
        { code: fact.code, ruleVersion: rule.ruleVersion },
      );
    }
    validated.push(fact);
  }

  // Deterministic contribution order by signal code ascending.
  const ordered = [...validated].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  let sum = 0;
  const contributions: RiskSignalContribution[] = [];
  const reasonCodes: string[] = [];
  const activeSignals: string[] = [];

  for (const fact of ordered) {
    const configuredWeight = rule.signalWeights[fact.code]!;
    const contribution = fact.active ? configuredWeight : 0;
    if (fact.active) {
      sum += contribution;
      activeSignals.push(fact.code);
      if (!reasonCodes.includes(fact.reasonCode)) {
        reasonCodes.push(fact.reasonCode);
      }
    }
    contributions.push({
      code: fact.code,
      active: fact.active,
      configuredWeight,
      contribution,
    });
  }

  // Stable reason-code ordering for reproducibility.
  reasonCodes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Deterministic safe system reason when no active signal contributed.
  // Persistence must store exactly this evaluator result (no substitution later).
  const finalReasonCodes =
    reasonCodes.length > 0 ? reasonCodes : (['NO_ACTIVE_SIGNALS'] as const);

  const score = Math.min(sum, 100);
  const riskTier = resolveRiskTier(score, rule.thresholds);
  const action = rule.actions[riskTier];

  return {
    score,
    riskTier,
    action,
    activeSignals,
    reasonCodes: finalReasonCodes,
    contributions,
    neverAutoBan: true,
    ruleVersion: rule.ruleVersion,
  };
}
