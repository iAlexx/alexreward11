export type SignerErrorCode =
  | 'ATTEMPT_NOT_FOUND'
  | 'POLICY_REJECTED'
  | 'FAKE_PHASE7_HASH'
  | 'MAINNET_REJECTED'
  | 'WALLET_MISMATCH'
  | 'CANONICAL_HASH_MISMATCH'
  | 'KMS_REJECTED'
  | 'SIGNATURE_VERIFY_FAILED'
  | 'UNAUTHORIZED'
  | 'SPIKE_DISABLED'
  | 'INVALID_REQUEST'
  | 'DB_DENIED'
  | 'ACTION_UNAVAILABLE';

export class SignerError extends Error {
  readonly code: SignerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: SignerErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
    this.details = details;
  }
}
