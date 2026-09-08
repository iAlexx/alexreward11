export type LedgerErrorCode =
  | 'VALIDATION'
  | 'UNBALANCED'
  | 'ASSET_MISMATCH'
  | 'ACCOUNT_ASSET_MISMATCH'
  | 'ASSET_INCOMPATIBLE'
  | 'ASSET_INACTIVE'
  | 'NEGATIVE_PROTECTED_BALANCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'BUSINESS_REFERENCE_CONFLICT'
  | 'ACCOUNT_NOT_FOUND'
  | 'TRANSACTION_NOT_FOUND'
  | 'REVERSAL_CONFLICT'
  | 'REVERSAL_INVALID'
  | 'OWNER_DECISION_REQUIRED'
  | 'INTERNAL';

export class LedgerDomainError extends Error {
  readonly code: LedgerErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: LedgerErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LedgerDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}
