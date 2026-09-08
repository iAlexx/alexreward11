export type RewardErrorCode =
  | 'VALIDATION'
  | 'ARITHMETIC_OVERFLOW'
  | 'RULE_NOT_FOUND'
  | 'RULE_AMBIGUOUS'
  | 'RULE_IMMUTABLE'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_NOT_FOUND'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_NOT_OPEN'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_STARTED'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_INVALID'
  | 'GUARDRAIL_BLOCKED'
  | 'BONUS_POLICY_REQUIRED'
  | 'BONUS_BLOCKED'
  | 'ISSUANCE_CONFLICT'
  | 'MATURITY_NOT_DUE'
  | 'MATURITY_INVALID_STATE'
  | 'CONFIG_CONFLICT'
  | 'INTERNAL';

export class RewardDomainError extends Error {
  readonly code: RewardErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RewardErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RewardDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}
