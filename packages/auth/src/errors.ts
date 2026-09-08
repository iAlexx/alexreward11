export type AuthErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_TOKEN'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'REFRESH_REPLAY'
  | 'REFRESH_RACE'
  | 'RATE_LIMITED'
  | 'CLAIM_REJECTED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'INTERNAL';

export class AuthDomainError extends Error {
  readonly code: AuthErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AuthErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuthDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}
