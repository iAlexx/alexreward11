/**
 * Phase 14 fraud / risk-rule core.
 *
 * Owns versioned risk rule resolution and immutable risk snapshot persistence.
 * Does not calculate multi-signal scores, write the ledger, approve payouts,
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
