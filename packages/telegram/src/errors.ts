export type InitDataErrorCode =
  | 'MALFORMED'
  | 'MISSING_HASH'
  | 'MISSING_AUTH_DATE'
  | 'MISSING_USER'
  | 'INVALID_SIGNATURE'
  | 'STALE_AUTH_DATE'
  | 'INVALID_USER'
  | 'UNSAFE_TELEGRAM_ID';

export class InitDataValidationError extends Error {
  readonly code: InitDataErrorCode;

  constructor(code: InitDataErrorCode, message: string) {
    super(message);
    this.name = 'InitDataValidationError';
    this.code = code;
  }
}
