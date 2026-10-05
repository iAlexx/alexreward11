export type SupportErrorCode =
  'UNAUTHORIZED' | 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INTERNAL';

export class SupportDomainError extends Error {
  readonly code: SupportErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SupportErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SupportDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/** Client-facing messages stay generic; internal codes stay precise. */
export function publicSupportFailureMessage(code: SupportErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Authentication required';
    case 'FORBIDDEN':
      return 'Support ticket is not available';
    case 'NOT_FOUND':
      return 'Support ticket was not found';
    case 'VALIDATION':
      return 'Invalid support request';
    case 'CONFLICT':
      return 'Support request could not be completed';
    case 'INTERNAL':
    default:
      return 'Support is temporarily unavailable';
  }
}
