/** Typed fail-closed errors for the Phase 15 referral rule core. */

export type ReferralErrorCode =
  | 'REFERRAL_RULE_NOT_CONFIGURED'
  | 'REFERRAL_RULE_INVALID'
  | 'REFERRAL_RULE_AMBIGUOUS'
  | 'REFERRAL_RULE_INTEGRITY'
  | 'REFERRAL_ENTITLEMENT_AMBIGUOUS'
  | 'REFERRAL_CODE_POLICY_NOT_CONFIGURED'
  | 'REFERRAL_CODE_POLICY_INVALID'
  | 'REFERRAL_CODE_POLICY_AMBIGUOUS'
  | 'INTERNAL';

export class ReferralDomainError extends Error {
  readonly code: ReferralErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ReferralErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ReferralDomainError';
    this.code = code;
    this.details = details;
  }
}
