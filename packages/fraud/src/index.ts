/**
 * Phase 14 fraud / risk-rule core.
 *
 * Owns versioned risk rule resolution, deterministic multi-signal evaluation,
 * immutable risk snapshots, and current risk_profiles.
 * Does not write the ledger, approve payouts, execute adverse actions,
 * or implement Trust / Eligibility engines.
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
  upsertRiskProfile,
  type PersistedRiskProfile,
  type UpsertRiskProfileInput,
} from './risk-profile.js';
export {
  evaluateAndPersistRisk,
  type EvaluateAndPersistRiskInput,
  type EvaluateAndPersistRiskResult,
} from './evaluate-and-persist.js';
