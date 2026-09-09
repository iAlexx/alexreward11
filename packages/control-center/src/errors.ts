export type ControlCenterErrorCode =
  | 'NOT_AUTHORIZED'
  | 'ACTION_EXPIRED'
  | 'ACTION_UNAVAILABLE'
  | 'ALREADY_PROCESSED'
  | 'STATE_CHANGED'
  | 'VALIDATION'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const SAFE_TELEGRAM_MESSAGES: Record<ControlCenterErrorCode, string> = {
  NOT_AUTHORIZED: 'You are not authorized for this action.',
  ACTION_EXPIRED: 'This action has expired. Request a new approval card.',
  ACTION_UNAVAILABLE: 'This action is not available.',
  ALREADY_PROCESSED: 'This action was already processed.',
  STATE_CHANGED: 'The resource state changed. Refresh and try again.',
  VALIDATION: 'The request could not be validated.',
  RATE_LIMITED: 'Too many requests. Please wait and try again.',
  INTERNAL: 'Something went wrong. Please try again later.',
};

export class ControlCenterError extends Error {
  readonly code: ControlCenterErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ControlCenterErrorCode,
    publicMessage?: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    const message = publicMessage ?? SAFE_TELEGRAM_MESSAGES[code];
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ControlCenterError';
    this.code = code;
    this.publicMessage = message;
    if (options?.details !== undefined) this.details = options.details;
  }

  /** Safe text for Telegram callback answers — never includes secrets. */
  toTelegramMessage(): string {
    return SAFE_TELEGRAM_MESSAGES[this.code];
  }
}

export function safeTelegramMessage(code: ControlCenterErrorCode): string {
  return SAFE_TELEGRAM_MESSAGES[code];
}
