/**
 * Phase 15 referral package.
 *
 * Step 1: versioned referral rule resolution.
 * Step 2: signed start_param parsing + one-time PENDING attribution.
 * Step 3: authoritative PENDING → ACTIVE/REJECTED activation.
 * Step 4: membership REFERRAL_RATE_BOOST effective rate (replacement, not additive).
 * Step 5–6: money issuance/reversal live in Reward Engine (this package must not import ledger).
 * Step 7: versioned code policy + ensureReferralCode + summary reads.
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
  TELEGRAM_START_MAX_LENGTH,
  REFERRAL_CODE_MAX_TELEGRAM_LENGTH,
  REFERRAL_CODE_MIN_LENGTH,
  buildReferralStartPayload,
  buildReferralBotStartLink,
  buildReferralMiniAppLaunchLink,
  buildMainMiniAppLaunchLink,
  isTelegramSafeReferralCodeAlphabetChar,
  type ReferralStartPayloadResult,
} from './telegram-links.js';
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
export {
  assertReferralCodePolicyShape,
  ensureReferralCode,
  readReferralSummary,
  referralCodeEntropyBits,
  resolveActiveReferralCodePolicy,
  type EnsureReferralCodeResult,
  type ReferralCodePolicyVersion,
} from './code-policy.js';
export {
  processPendingReferralActivationBatch,
  type PendingReferralActivationBatchItem,
  type ProcessPendingReferralActivationBatchOptions,
  type ProcessPendingReferralActivationBatchResult,
} from './runtime.js';
