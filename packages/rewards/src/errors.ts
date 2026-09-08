export type RewardErrorCode =
  | 'VALIDATION'
  | 'ARITHMETIC_OVERFLOW'
  | 'RULE_NOT_FOUND'
  | 'RULE_AMBIGUOUS'
  | 'RULE_IMMUTABLE'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_NOT_FOUND'
  | 'BUDGET_SCOPE_MISMATCH'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_NOT_OPEN'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_STARTED'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_INVALID'
  | 'SOURCE_NOT_REGISTERED'
  | 'GUARDRAIL_BLOCKED'
  | 'BONUS_POLICY_REQUIRED'
  | 'BONUS_BLOCKED'
  | 'BONUS_UNAVAILABLE'
  | 'AMBIGUOUS_BONUS'
  | 'BONUS_RESOLUTION_CONFLICT'
  | 'MARGIN_POLICY_UNDEFINED'
  | 'OWNER_DECISION_REQUIRED'
  | 'ISSUANCE_CONFLICT'
  | 'MATURITY_NOT_DUE'
  | 'MATURITY_INVALID_STATE'
  | 'CONFIG_CONFLICT'
  | 'INTERNAL';

/** Economic unavailability codes that may downgrade under BASE_REWARD_ONLY. */
export const BONUS_ECONOMIC_UNAVAILABLE_CODES: ReadonlySet<RewardErrorCode> = new Set([
  'BUDGET_EXHAUSTED',
  'BUDGET_NOT_FOUND',
  'BUDGET_SCOPE_MISMATCH',
  'BONUS_UNAVAILABLE',
]);

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

export function isBonusEconomicUnavailability(error: unknown): error is RewardDomainError {
  return error instanceof RewardDomainError && BONUS_ECONOMIC_UNAVAILABLE_CODES.has(error.code);
}
