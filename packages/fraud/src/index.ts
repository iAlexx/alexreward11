/**
 * Phase 14 fraud / risk / trust / eligibility core.
 *
 * Owns versioned risk rule resolution, risk evaluation + snapshots/profiles,
 * Trust rule-version authority + immutable trust snapshots, and Eligibility
 * policy-version authority + immutable reason-coded decision persistence.
 * Does not write the ledger, approve payouts, execute adverse actions,
 * invent Trust scoring policy, or implement Eligibility business evaluation.
 */

export { FraudDomainError, type FraudErrorCode } from './errors.js';
export {
  assertJsonCompatibleValue,
  assertSafePersistedJsonObject,
  canonicalizeForDigest,
  computeRiskInputsDigest,
  isPlainJsonObject,
  isSensitivePersistedKey,
  normalizeSensitiveKey,
} from './canonical.js';
export {
  RISK_ACTION_CODES,
  SIGNAL_CODE_PATTERN,
  isValidSignalCode,
  loadRiskRuleVersionByNumber,
  parseRiskActions,
  parseRiskSignalWeights,
  parseRiskThresholds,
  resolveActiveRiskRuleVersion,
  validateRiskRuleConfig,
  type ResolvedRiskRuleVersion,
  type RiskActionCode,
  type RiskActionsConfig,
  type RiskRuleStatus,
  type RiskRuleVersion,
  type RiskSignalWeightsConfig,
  type RiskThresholdsConfig,
  type RiskTier,
} from './risk-rule.js';
export {
  persistRiskSnapshot,
  type PersistRiskSnapshotInput,
  type PersistedRiskSnapshot,
  type RiskDecisionScope,
} from './risk-snapshot.js';
export {
  evaluateRiskSignals,
  type RiskEvaluationResult,
  type RiskSignalContribution,
  type RiskSignalFact,
} from './risk-evaluator.js';
export {
  STEP3_COLLECTOR_SIGNAL_CODES,
  collectConfiguredRiskSignals,
  type CollectConfiguredRiskSignalsInput,
  type CollectConfiguredRiskSignalsResult,
  type Step3CollectorSignalCode,
} from './risk-signal-collector.js';
/** Read type only — current risk profile writes go through evaluateAndPersistRisk. */
export type { PersistedRiskProfile } from './risk-profile.js';
export {
  evaluateAndPersistRisk,
  type EvaluateAndPersistRiskInput,
  type EvaluateAndPersistRiskResult,
} from './evaluate-and-persist.js';
export {
  loadTrustRuleVersionByNumber,
  resolveActiveTrustRuleVersion,
  type ResolvedTrustRuleVersion,
  type TrustRuleStatus,
  type TrustRuleVersion,
} from './trust-rule.js';
export {
  persistTrustSnapshot,
  type PersistTrustSnapshotInput,
  type PersistedTrustSnapshot,
  type TrustState,
} from './trust-snapshot.js';
export {
  loadEligibilityPolicyVersionByNumber,
  resolveActiveEligibilityPolicyVersion,
  type EligibilityPolicyStatus,
  type EligibilityPolicyVersion,
  type ResolvedEligibilityPolicyVersion,
} from './eligibility-policy.js';
export {
  ELIGIBILITY_ACTION_TYPES,
  ELIGIBILITY_OUTCOMES,
  computeEligibilityInputsDigest,
  persistEligibilityDecision,
  type EligibilityActionType,
  type EligibilityDigestInput,
  type EligibilityOutcome,
  type PersistEligibilityDecisionInput,
  type PersistedEligibilityDecision,
} from './eligibility-decision.js';
