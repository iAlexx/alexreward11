export interface KmsKeyDescription {
  readonly keySpec: string;
  readonly keyUsage: string;
  readonly signingAlgorithm: string;
  readonly messageType: string;
}

/**
 * Signing port. Real AWS KMS adapter lives only in apps/signer.
 * Local ephemeral adapter is TEST/SPIKE only and does not satisfy formal KMS gate.
 */
export interface SignPort {
  getPublicKey(): Promise<Buffer>;
  /** Sign exact message bytes with Ed25519 (KMS: ED25519_SHA_512 + MessageType RAW). */
  signEd25519RawMessage(message: Buffer): Promise<Buffer>;
  describe(): Promise<KmsKeyDescription>;
}
