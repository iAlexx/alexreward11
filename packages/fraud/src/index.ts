/**
 * Phase 14 fraud / risk / trust / eligibility core.
 *
 * Owns versioned risk rule resolution (including signal_params), risk evaluation
 * + snapshots/profiles, Step 3/11 risk signal collectors, Trust rule-version
 * authority + versioned Trust policy_config + collector/evaluator + immutable
 * trust snapshots + users.trust_state projection, Eligibility policy-version
 * authority + immutable reason-coded decision persistence, a pure deterministic
 * Eligibility gate evaluator with versioned action policy config (requiredGates
 * + precedence + riskAllowedActions), and the authoritative
 * evaluateAndPersistEligibility path. Does not write the ledger, approve
 * payouts, execute adverse actions, invent production Trust/Risk thresholds,
 * invent country authority, or invent production Eligibility policy seeds.
 * Trust stays separate from Risk and never grants payout benefits.
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
  parseRiskSignalParams,
  parseRiskSignalWeights,
  parseRiskThresholds,
  resolveActiveRiskRuleVersion,
  resolveActiveRiskRuleVersionForEvaluation,
  validateRiskRuleConfig,
  type ResolvedRiskRuleVersion,
  type RiskActionCode,
  type RiskActionsConfig,
  type RiskHistorySignalParams,
  type RiskRuleStatus,
  type RiskRuleVersion,
  type RiskSignalParamsConfig,
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
  COLLECTOR_SIGNAL_CODES,
  STEP11_HISTORY_SIGNAL_CODES,
  STEP3_COLLECTOR_SIGNAL_CODES,
  collectConfiguredRiskSignals,
  type CollectConfiguredRiskSignalsInput,
  type CollectConfiguredRiskSignalsResult,
  type CollectorSignalCode,
  type Step11HistorySignalCode,
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
  TRUST_SIGNAL_CODES,
  loadTrustRuleVersionByNumber,
  loadTrustRuleVersionForSnapshot,
  parseTrustPolicyConfig,
  resolveActiveTrustRuleVersion,
  resolveActiveTrustRuleVersionForEvaluation,
  type ResolvedTrustRuleVersion,
  type TrustAccountAgeSignalConfig,
  type TrustConfirmedPayoutHistorySignalConfig,
  type TrustPolicyConfig,
  type TrustPolicySignalsConfig,
  type TrustRewardedAdHistorySignalConfig,
  type TrustRuleStatus,
  type TrustRuleVersion,
  type TrustSignalCode,
  type TrustStateThresholdsConfig,
  type TrustVerifiedPrimaryWalletAgeSignalConfig,
} from './trust-rule.js';
export {
  persistTrustSnapshot,
  type PersistTrustSnapshotInput,
  type PersistedTrustSnapshot,
  type TrustState,
} from './trust-snapshot.js';
export {
  evaluateTrustSignals,
  type TrustEvaluationResult,
  type TrustSignalContribution,
  type TrustSignalFact,
} from './trust-evaluator.js';
export {
  collectConfiguredTrustSignals,
  type CollectConfiguredTrustSignalsInput,
  type CollectConfiguredTrustSignalsResult,
} from './trust-signal-collector.js';
export {
  evaluateAndPersistTrust,
  type EvaluateAndPersistTrustInput,
  type EvaluateAndPersistTrustResult,
} from './evaluate-and-persist-trust.js';
export {
  loadEligibilityPolicyVersionByNumber,
  parseEligibilityPolicyConfig,
  resolveActiveEligibilityPolicyVersion,
  resolveActiveEligibilityPolicyVersionForEvaluation,
  type EligibilityActionPolicyConfig,
  type EligibilityPolicyConfig,
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
export {
  ELIGIBILITY_GATE_CODES,
  evaluateConfiguredEligibility,
  evaluateEligibilityGates,
  type ConfiguredEligibilityEvaluationResult,
  type ConfiguredEligibilityEvaluatorPolicy,
  type EligibilityEvaluationResult,
  type EligibilityEvaluatorPolicy,
  type EligibilityGateCode,
  type EligibilityGateFact,
  type EligibilityGateStateEntry,
} from './eligibility-evaluator.js';
export {
  evaluateAndPersistEligibility,
  type DeploymentEnvironment,
  type EvaluateAndPersistEligibilityInput,
  type EvaluateAndPersistEligibilityResult,
} from './evaluate-and-persist-eligibility.js';
export {
  classifyAccountStateForAction,
  resolveEligibilityFeatureFlagBinding,
  type AccountStateClassification,
  type AccountStateClass,
  type AccountStateSnapshot,
  type EligibilityFeatureFlagBinding,
} from './eligibility-gate-semantics.js';
