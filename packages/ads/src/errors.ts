export type AdsErrorCode =
  | 'VALIDATION'
  | 'PROVIDER_NOT_REGISTERED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_UNHEALTHY'
  | 'PROVIDER_MONETARY_BLOCKED'
  | 'LIMIT_RULE_MISSING'
  | 'LIMIT_RULE_AMBIGUOUS'
  | 'REQUEST_LIMIT_REACHED'
  | 'SUCCESS_LIMIT_REACHED'
  | 'SESSION_ALREADY_ACTIVE'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_TERMINAL'
  | 'SESSION_EXPIRED'
  | 'SESSION_STATE_INVALID'
  | 'SESSION_USER_MISMATCH'
  | 'SIGNAL_REJECTED'
  | 'SIGNAL_TYPE_UNKNOWN'
  | 'CORRELATION_AMBIGUOUS'
  | 'AUTHENTICITY_INSUFFICIENT'
  | 'QUOTE_MISSING'
  | 'REWARD_NOT_AUTHORIZED'
  | 'CLARIFICATION_GATE_OPEN'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'RATE_LIMITED'
  | 'CERTIFICATION_CASE_UNSUPPORTED'
  | 'OWNER_DECISION_REQUIRED'
  | 'INTERNAL';

/**
 * Codes that describe a *refusal to create money* rather than a broken request.
 * Callers may surface these to the user as "not available right now" without
 * treating them as platform faults.
 */
export const ADS_MONETARY_REFUSAL_CODES: ReadonlySet<AdsErrorCode> = new Set([
  'PROVIDER_MONETARY_BLOCKED',
  'AUTHENTICITY_INSUFFICIENT',
  'CORRELATION_AMBIGUOUS',
  'CLARIFICATION_GATE_OPEN',
  'REWARD_NOT_AUTHORIZED',
]);

export class AdsDomainError extends Error {
  readonly code: AdsErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AdsErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AdsDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}

export function isAdsMonetaryRefusal(error: unknown): error is AdsDomainError {
  return error instanceof AdsDomainError && ADS_MONETARY_REFUSAL_CODES.has(error.code);
}
