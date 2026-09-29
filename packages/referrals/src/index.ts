/**
 * Phase 15 referral package.
 *
 * Step 1: versioned referral rule resolution.
 * Step 2: signed start_param parsing + one-time PENDING attribution.
 * Does not activate referrals, issue referral money, generate production codes,
 * resolve REFERRAL_RATE_BOOST, or talk to Telegram HMAC validation directly.
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
