export const SIGNER_BOUNDARY = {
  mayAccessUsableHotWalletSigningCapability: true as const,
  mayWriteFinancialDb: false as const,
  mayBroadcastTon: false as const,
  mayCallTonRpc: false as const,
  publicIngress: false as const,
  acceptedCallerInput: ['withdrawalAttemptId'] as const,
  walletVersion: 'v5R1' as const,
  networkGlobalIdTestnet: -3 as const,
  networkGlobalIdMainnet: -239 as const,
  signingAlgorithm: 'ED25519_SHA_512' as const,
  messageType: 'RAW' as const,
  custodyModel: 'FALLBACK_ENCRYPTED' as const,
  /** Exact bytes signed: Wallet V5 R1 signing Cell hash (32 bytes). */
  signedMessageDescription: 'signingMessage.endCell().hash() — 32-byte Cell hash; MessageType RAW',
} as const;

export const PHASE9_DEFERRED_TO_PHASE_10 = [
  'TON chain broadcast / RPC submission',
  'chain watcher',
  'real payout dispatch confirmation',
  '100+ payout run',
  'crash-after-real-broadcast tests',
  'provider reconciliation against TON',
] as const;

/** Historical AWS KMS spike checklist — TECHNICALLY PROVEN, not production custody. */
export const PHASE9_HISTORICAL_AWS_KMS_EVIDENCE = [
  'create/use test KMS Ed25519 key (historical AWS spike)',
  'retrieve public key',
  'derive exact Wallet V5 R1 state',
  'build signed external message bytes',
  'call KMS signing correctly',
  'verify signature locally',
] as const;

export const PHASE9_COMPLETED_FROM_SPEC_34_2 = [
  'self-hosted encrypted Ed25519 key bundle (Argon2id + XChaCha20-Poly1305)',
  'LOCKED boot / explicit unlock / optional re-lock',
  'retrieve public key after unlock',
  'derive exact Wallet V5 R1 TESTNET state',
  'build signed external message bytes',
  'sign with in-memory Ed25519 key only inside apps/signer',
  'verify signature locally',
] as const;
