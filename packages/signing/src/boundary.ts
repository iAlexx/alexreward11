export const SIGNER_BOUNDARY = {
  mayInvokeKmsSign: true as const,
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
  /** Exact bytes signed by KMS: Wallet V5 R1 signing Cell hash (32 bytes). */
  kmsMessageDescription: 'signingMessage.endCell().hash() — 32-byte Cell hash; MessageType RAW',
} as const;

export const PHASE9_DEFERRED_TO_PHASE_10 = [
  'TON chain broadcast / RPC submission',
  'chain watcher',
  'real payout dispatch confirmation',
  '100+ payout run',
  'crash-after-real-broadcast tests',
  'provider reconciliation against TON',
] as const;

export const PHASE9_COMPLETED_FROM_SPEC_34_2 = [
  'create/use test KMS Ed25519 key (formal spike requires real AWS)',
  'retrieve public key',
  'derive exact Wallet V5 R1 state',
  'build signed external message bytes',
  'call KMS signing correctly',
  'verify signature locally',
] as const;
