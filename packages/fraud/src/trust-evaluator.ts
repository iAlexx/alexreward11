import { assertSafePersistedJsonObject } from './canonical.js';
import { FraudDomainError } from './errors.js';
import type { TrustPolicyConfig, TrustSignalCode } from './trust-rule.js';
import { TRUST_SIGNAL_CODES } from './trust-rule.js';
import type { TrustState } from './trust-snapshot.js';

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const TRUST_SIGNAL_CODE_SET = new Set<string>(TRUST_SIGNAL_CODES);

/**
 * Server-produced Trust signal fact.
 * Caller supplies code/satisfied/reason only — never weight, score, or state.
 */
export interface TrustSignalFact {
  readonly code: string;
  readonly satisfied: boolean;
  readonly reasonCode: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
}

export interface TrustSignalContribution {
  readonly code: string;
  readonly satisfied: boolean;
  readonly configuredWeight: number;
  readonly contribution: number;
}

export interface TrustEvaluationResult {
  readonly score: number;
  readonly trustState: TrustState;
  readonly satisfiedSignals: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly contributions: readonly TrustSignalContribution[];
}

function assertReasonCode(code: string): string {
  if (!REASON_CODE_PATTERN.test(code)) {
    throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', `invalid reasonCode ${code}`, { code });
  }
  return code;
}

function assertSignalFact(fact: TrustSignalFact): TrustSignalFact {
  if (!TRUST_SIGNAL_CODE_SET.has(fact.code)) {
    throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', `invalid trust signal code ${fact.code}`, {
      code: fact.code,
    });
  }
  if (typeof fact.satisfied !== 'boolean') {
    throw new FraudDomainError('TRUST_SNAPSHOT_INVALID', 'signal satisfied must be boolean', {
      code: fact.code,
    });
  }
  assertReasonCode(fact.reasonCode);
  if (fact.safeDetails !== undefined) {
    assertSafePersistedJsonObject(`signal.${fact.code}.safeDetails`, fact.safeDetails);
  }
  return fact;
}

function resolveTrustState(score: number, thresholds: TrustPolicyConfig['stateThresholds']): TrustState {
  if (score < thresholds.basicMin) return 'NEW';
  if (score < thresholds.establishedMin) return 'BASIC';
  if (score < thresholds.trustedMin) return 'ESTABLISHED';
  return 'TRUSTED';
}

function configuredWeight(
  policy: TrustPolicyConfig,
  code: TrustSignalCode,
): number | undefined {
  const signals = policy.signals;
  switch (code) {
    case 'ACCOUNT_AGE':
      return signals.ACCOUNT_AGE?.weight;
    case 'VERIFIED_PRIMARY_WALLET_AGE':
      return signals.VERIFIED_PRIMARY_WALLET_AGE?.weight;
    case 'REWARDED_AD_HISTORY':
      return signals.REWARDED_AD_HISTORY?.weight;
    case 'CONFIRMED_PAYOUT_HISTORY':
      return signals.CONFIRMED_PAYOUT_HISTORY?.weight;
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

/**
 * Deterministic Trust evaluation from policy_config + collected facts.
 *
 * Each satisfied configured signal contributes its exact integer weight once.
 * Unsatisfied signals contribute 0. score = min(sum, 100).
 * Pure: no DB, no Risk mutation, no membership / Founder reads.
 */
export function evaluateTrustSignals(
  policyConfig: TrustPolicyConfig,
  signalFacts: readonly TrustSignalFact[],
): TrustEvaluationResult {
  const seen = new Set<string>();
  const validated: TrustSignalFact[] = [];

  for (const raw of signalFacts) {
    const fact = assertSignalFact(raw);
    if (seen.has(fact.code)) {
      throw new FraudDomainError(
        'TRUST_SNAPSHOT_INVALID',
        `duplicate trust signal code ${fact.code}`,
        { code: fact.code },
      );
    }
    seen.add(fact.code);

    const weight = configuredWeight(policyConfig, fact.code as TrustSignalCode);
    if (weight === undefined) {
      throw new FraudDomainError(
        'TRUST_POLICY_CONFIG_INVALID',
        `signal code ${fact.code} is not present in policy_config.signals`,
        { code: fact.code },
      );
    }
    validated.push(fact);
  }

  const ordered = [...validated].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  let sum = 0;
  const contributions: TrustSignalContribution[] = [];
  const reasonCodes: string[] = [];
  const satisfiedSignals: string[] = [];

  for (const fact of ordered) {
    const weight = configuredWeight(policyConfig, fact.code as TrustSignalCode)!;
    const contribution = fact.satisfied ? weight : 0;
    if (fact.satisfied) {
      sum += contribution;
      satisfiedSignals.push(fact.code);
      if (!reasonCodes.includes(fact.reasonCode)) {
        reasonCodes.push(fact.reasonCode);
      }
    }
    contributions.push({
      code: fact.code,
      satisfied: fact.satisfied,
      configuredWeight: weight,
      contribution,
    });
  }

  reasonCodes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const finalReasonCodes =
    reasonCodes.length > 0 ? reasonCodes : (['NO_SATISFIED_SIGNALS'] as const);

  const score = Math.min(sum, 100);
  const trustState = resolveTrustState(score, policyConfig.stateThresholds);

  return {
    score,
    trustState,
    satisfiedSignals,
    reasonCodes: finalReasonCodes,
    contributions,
  };
}
