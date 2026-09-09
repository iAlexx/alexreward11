export type TonErrorCode =
  | 'VALIDATION'
  | 'INVALID_PROOF'
  | 'INVALID_DOMAIN'
  | 'INVALID_NETWORK'
  | 'INVALID_WALLET'
  | 'INVALID_ADDRESS'
  | 'STALE_PROOF'
  | 'FUTURE_PROOF'
  | 'INTERNAL';

export class TonDomainError extends Error {
  readonly code: TonErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: TonErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TonDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}
