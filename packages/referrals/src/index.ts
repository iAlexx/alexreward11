/**
 * Phase 15 referral rule-version core.
 *
 * Owns versioned referral rule resolution only. Does not attribute edges, activate
 * referrals, issue referral money, compute effective rates, or talk to Telegram.
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
