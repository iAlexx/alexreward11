/**
 * Phase 15 referral package.
 *
 * Step 1: versioned referral rule resolution.
 * Step 2: signed start_param parsing + one-time PENDING attribution.
 * Step 3: authoritative PENDING → ACTIVE/REJECTED activation.
 * Step 4: membership REFERRAL_RATE_BOOST effective rate (replacement, not additive).
 * Does not issue referral money or generate production codes.
 */

export { ReferralDomainError, type ReferralErrorCode } from './errors.js';
export {
  loadReferralRuleVersionByNumber,
  mapReferralRuleRow,
  resolveActiveReferralRuleVersion,
  resolveActiveReferralRuleVersionForEvaluation,
  type ReferralRuleStatus,
  type ReferralRuleVersion,
  type ResolvedReferralRuleVersion,
} from './referral-rule.js';
export {
  REFERRAL_START_PREFIX,
  parseReferralStartParam,
  type ReferralStartParamParseResult,
} from './start-param.js';
export {
  attributeReferralCode,
  type ReferralAttributionOutcome,
} from './attribution.js';
export {
  CRITICAL_FRAUD_REJECTION_REASON,
  evaluateReferralActivation,
  type ReferralActivationOutcome,
} from './activation.js';
export {
  REFERRAL_RATE_BOOST_CODE,
  resolveEffectiveReferralRate,
  type EffectiveReferralRate,
  type ReferralRateSource,
} from './effective-rate.js';
