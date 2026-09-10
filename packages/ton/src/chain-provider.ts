/**
 * Provider-neutral TON chain port for Phase 10 Testnet payout (outside apps/signer).
 * Signer must NEVER import this for broadcast / RPC submission.
 */

export const TON_TESTNET_NETWORK_GLOBAL_ID = -3 as const;
export const TON_MAINNET_NETWORK_GLOBAL_ID = -239 as const;

export type TonNetworkGlobalId =
  typeof TON_TESTNET_NETWORK_GLOBAL_ID | typeof TON_MAINNET_NETWORK_GLOBAL_ID;

/** Domain evidence for matching an intended Jetton payout transfer. */
export interface JettonTransferEvidence {
  readonly hotWallet: string;
  readonly jettonMaster: string;
  readonly recipient: string;
  /** Atomic Jetton amount as decimal string (exact match required). */
  readonly amountAtomic: string;
  /** query_id as decimal string. */
  readonly queryId: string;
  readonly success: boolean;
  readonly bounced: boolean;
  readonly transactionHash?: string;
  readonly lt?: string;
  readonly networkGlobalId?: number;
  readonly senderJettonWallet?: string;
  readonly providerKind?: string;
  /** Furthest independently verified stage in the TEP-74 message chain. */
  readonly proofStage?: 'HOT_WALLET' | 'JETTON_WALLET' | 'RECIPIENT' | 'COMPLETE';
  readonly hotWalletTxHash?: string;
  readonly jettonWalletTxHash?: string;
  readonly recipientEvidence?: string;
  readonly traceId?: string;
}

export interface TonAccountBalance {
  readonly address: string;
  /** Native TON nanotons as decimal string. */
  readonly balanceNanotons: string;
}

export interface TonJettonBalance {
  readonly ownerAddress: string;
  readonly jettonMaster: string;
  readonly balanceAtomic: string;
}

export interface TonSendBocResult {
  readonly accepted: boolean;
  readonly messageHash?: string;
  readonly providerReference?: string;
}

export interface TonProviderHealth {
  readonly ok: boolean;
  readonly networkGlobalId: TonNetworkGlobalId;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface FindTransactionsByQueryIdInput {
  readonly hotWallet: string;
  readonly jettonMaster: string;
  readonly queryId: string;
  readonly recipient?: string;
  /** Hash of the final normalized External-In message cell. */
  readonly normalizedExternalMessageHash?: string;
  /** Expected sender-side Jetton wallet owned by hotWallet. */
  readonly senderJettonWallet?: string;
  /** Exact expected atomic Jetton amount. */
  readonly amountAtomic?: string;
}

/**
 * Thin chain provider port — HTTP adapters and fakes implement this.
 * Broadcast lives in the worker/withdrawals path, never in apps/signer.
 */
export interface TonChainProvider {
  readonly networkGlobalId: TonNetworkGlobalId;

  getSeqno(address: string): Promise<number>;

  getAccountBalance(address: string): Promise<TonAccountBalance>;

  getJettonBalance(ownerAddress: string, jettonMaster: string): Promise<TonJettonBalance>;

  /** Submit a signed external message BOC (base64). */
  sendBoc(bocBase64: string): Promise<TonSendBocResult>;

  findTransactionsByQueryId(
    input: FindTransactionsByQueryIdInput,
  ): Promise<readonly JettonTransferEvidence[]>;

  /** Observe Jetton transfer evidence for a known query id (alias surface). */
  observeJettonTransfer(
    input: FindTransactionsByQueryIdInput,
  ): Promise<JettonTransferEvidence | null>;

  health(): Promise<TonProviderHealth>;
}

export function assertTestnetOnly(networkGlobalId: number): asserts networkGlobalId is -3 {
  if (networkGlobalId === TON_MAINNET_NETWORK_GLOBAL_ID) {
    throw new Error('MAINNET rejected: networkGlobalId -239 is forbidden (Phase 10 Testnet only)');
  }
  if (networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    throw new Error(
      `Unsupported networkGlobalId ${networkGlobalId}; Phase 10 requires TESTNET (-3)`,
    );
  }
}
