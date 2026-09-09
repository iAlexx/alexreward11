export type WithdrawalErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_NOT_OPEN'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CONSUMED'
  | 'WALLET_INELIGIBLE'
  | 'COOLDOWN_ACTIVE'
  | 'ACCOUNT_BLOCKED'
  | 'PAUSED'
  | 'FEE_RULE_AMBIGUOUS'
  | 'FEE_RULE_NOT_FOUND'
  | 'LIMIT_RULE_AMBIGUOUS'
  | 'LIMIT_RULE_NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'INSUFFICIENT_AVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ENTITLEMENT_AMBIGUOUS'
  | 'STATE_CONFLICT'
  | 'TRANSITION_FORBIDDEN'
  | 'RECONCILE_REQUIRED'
  | 'CONFIG'
  | 'INTERNAL';

export class WithdrawalDomainError extends Error {
  readonly code: WithdrawalErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WithdrawalErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WithdrawalDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}
