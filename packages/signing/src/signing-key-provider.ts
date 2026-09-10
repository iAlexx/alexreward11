/**
 * Provider-neutral Ed25519 signing port.
 * Real production custody adapters live in apps/signer (and encrypted local provider).
 * Historical AWS KMS adapter was removed from the production path by Owner decision (v1.3).
 */
export interface SigningKeyDescription {
  readonly keySpec: string;
  readonly keyUsage: string;
  readonly signingAlgorithm: string;
  readonly messageType: string;
  readonly provider: string;
}

/** @deprecated Use SigningKeyDescription — kept as type alias for transitional imports. */
export type KmsKeyDescription = SigningKeyDescription;

export type SignerCustodyState = 'LOCKED' | 'UNLOCKED';

/**
 * Signing port. Production private material is available only after explicit unlock
 * for self-hosted encrypted custody.
 */
export interface SignPort {
  getPublicKey(): Promise<Buffer>;
  /** Sign exact message bytes with Ed25519 (ED25519_SHA_512 semantics + RAW message bytes). */
  signEd25519RawMessage(message: Buffer): Promise<Buffer>;
  describe(): Promise<SigningKeyDescription>;
}

/** Extended port for lockable self-hosted encrypted custody. */
export interface LockableSignPort extends SignPort {
  readonly custodyState: SignerCustodyState;
  /** True when unlocked and ready to sign. */
  isSigningReady(): boolean;
  /** Decrypt and load signing material into memory. Fail closed on error. */
  unlock(passphrase: string): Promise<void>;
  /**
   * Best-effort destroy of in-memory signing material and return to LOCKED.
   * JavaScript/Node.js cannot guarantee perfect zeroization.
   */
  relock(): void;
}
