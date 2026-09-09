export type WalletErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_CONSUMED'
  | 'CHALLENGE_INVALIDATED'
  | 'REPLAY'
  | 'INVALID_PROOF'
  | 'INVALID_DOMAIN'
  | 'INVALID_NETWORK'
  | 'INVALID_WALLET'
  | 'INVALID_ADDRESS'
  | 'PRIMARY_REQUIRED'
  | 'RATE_LIMITED'
  | 'CONFIG'
  | 'INTERNAL';

export class WalletDomainError extends Error {
  readonly code: WalletErrorCode;
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WalletErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> },
  ) {
    super(publicMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WalletDomainError';
    this.code = code;
    this.publicMessage = publicMessage;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/** Client-facing messages stay generic; internal codes stay precise. */
export function publicWalletFailureMessage(code: WalletErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Authentication required';
    case 'RATE_LIMITED':
      return 'Too many attempts. Try again later.';
    case 'INVALID_NETWORK':
      return 'Network is not accepted';
    case 'CHALLENGE_EXPIRED':
    case 'CHALLENGE_CONSUMED':
    case 'CHALLENGE_INVALIDATED':
    case 'CHALLENGE_NOT_FOUND':
    case 'REPLAY':
    case 'INVALID_PROOF':
    case 'INVALID_DOMAIN':
    case 'INVALID_WALLET':
    case 'INVALID_ADDRESS':
      return 'Wallet ownership proof was rejected';
    case 'PRIMARY_REQUIRED':
      return 'Primary wallet change requires a verified wallet';
    case 'CONFIG':
    case 'INTERNAL':
      return 'Wallet verification is temporarily unavailable';
    default:
      return 'Request could not be completed';
  }
}
