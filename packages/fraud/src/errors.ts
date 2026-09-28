/** Typed fail-closed errors for the Phase 14 fraud / risk-rule core. */

export type FraudErrorCode =
  | 'RISK_RULE_NOT_CONFIGURED'
  | 'RISK_RULE_INTEGRITY'
  | 'RISK_RULE_CONFIG_INVALID'
  | 'RISK_RULE_NOT_FOUND'
  | 'RISK_SNAPSHOT_INVALID'
  | 'RISK_SNAPSHOT_PERSIST_FAILED'
  | 'RISK_SIGNAL_INVALID'
  | 'RISK_SIGNAL_DUPLICATE'
  | 'RISK_SIGNAL_UNCONFIGURED'
  | 'RISK_PROFILE_PERSIST_FAILED'
  | 'INTERNAL';

export class FraudDomainError extends Error {
  readonly code: FraudErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: FraudErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'FraudDomainError';
    this.code = code;
    this.details = details;
  }
}
