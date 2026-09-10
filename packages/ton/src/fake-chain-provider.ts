import {
  assertTestnetOnly,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type FindTransactionsByQueryIdInput,
  type JettonTransferEvidence,
  type TonAccountBalance,
  type TonChainProvider,
  type TonJettonBalance,
  type TonProviderHealth,
  type TonSendBocResult,
} from './chain-provider.js';

export interface FakeTonChainProviderOptions {
  readonly networkGlobalId?: number;
  /** When true, sendBoc throws a timeout-style error after marking submitted. */
  readonly sendBocTimeout?: boolean;
  /** When true, sendBoc throws before any submit side-effect. */
  readonly sendBocFailBeforeSubmit?: boolean;
}

/**
 * Deterministic in-memory fake for unit tests. Not for production paths.
 */
export class FakeTonChainProvider implements TonChainProvider {
  readonly networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;

  private readonly seqnoByAddress = new Map<string, number>();
  private readonly balances = new Map<string, string>();
  private readonly jettonBalances = new Map<string, string>();
  private readonly transfers: JettonTransferEvidence[] = [];
  private readonly submittedBocs: string[] = [];
  private sendBocTimeout: boolean;
  private sendBocFailBeforeSubmit: boolean;
  private sendBocCallCount = 0;

  constructor(options: FakeTonChainProviderOptions = {}) {
    assertTestnetOnly(options.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID);
    this.sendBocTimeout = options.sendBocTimeout === true;
    this.sendBocFailBeforeSubmit = options.sendBocFailBeforeSubmit === true;
  }

  seedSeqno(address: string, seqno: number): void {
    this.seqnoByAddress.set(address, seqno);
  }

  seedAccountBalance(address: string, balanceNanotons: string): void {
    this.balances.set(address, balanceNanotons);
  }

  seedJettonBalance(ownerAddress: string, jettonMaster: string, balanceAtomic: string): void {
    this.jettonBalances.set(`${ownerAddress}|${jettonMaster}`, balanceAtomic);
  }

  seedTransfer(evidence: JettonTransferEvidence): void {
    this.transfers.push(evidence);
  }

  getSubmittedBocs(): readonly string[] {
    return [...this.submittedBocs];
  }

  getSendBocCallCount(): number {
    return this.sendBocCallCount;
  }

  setSendBocTimeout(value: boolean): void {
    this.sendBocTimeout = value;
  }

  setSendBocFailBeforeSubmit(value: boolean): void {
    this.sendBocFailBeforeSubmit = value;
  }

  async getSeqno(address: string): Promise<number> {
    return this.seqnoByAddress.get(address) ?? 0;
  }

  async getAccountBalance(address: string): Promise<TonAccountBalance> {
    return {
      address,
      balanceNanotons: this.balances.get(address) ?? '0',
    };
  }

  async getJettonBalance(ownerAddress: string, jettonMaster: string): Promise<TonJettonBalance> {
    return {
      ownerAddress,
      jettonMaster,
      balanceAtomic: this.jettonBalances.get(`${ownerAddress}|${jettonMaster}`) ?? '0',
    };
  }

  async sendBoc(bocBase64: string): Promise<TonSendBocResult> {
    this.sendBocCallCount += 1;
    if (this.sendBocFailBeforeSubmit) {
      throw new Error('FAKE_PROVIDER_PRE_SUBMIT_FAILURE');
    }
    if (this.sendBocTimeout) {
      this.submittedBocs.push(bocBase64);
      throw new Error('FAKE_PROVIDER_RPC_TIMEOUT');
    }
    this.submittedBocs.push(bocBase64);
    return {
      accepted: true,
      messageHash: `fake-msg-${this.submittedBocs.length}`,
      providerReference: `fake-ref-${this.submittedBocs.length}`,
    };
  }

  async findTransactionsByQueryId(
    input: FindTransactionsByQueryIdInput,
  ): Promise<readonly JettonTransferEvidence[]> {
    return this.transfers.filter(
      (t) =>
        t.hotWallet === input.hotWallet &&
        t.jettonMaster === input.jettonMaster &&
        t.queryId === input.queryId &&
        (input.recipient === undefined || t.recipient === input.recipient) &&
        (input.amountAtomic === undefined || t.amountAtomic === input.amountAtomic) &&
        (input.senderJettonWallet === undefined ||
          t.senderJettonWallet === input.senderJettonWallet),
    );
  }

  async observeJettonTransfer(
    input: FindTransactionsByQueryIdInput,
  ): Promise<JettonTransferEvidence | null> {
    const matches = await this.findTransactionsByQueryId(input);
    return matches.find((evidence) => evidence.proofStage === 'COMPLETE') ?? matches[0] ?? null;
  }

  async health(): Promise<TonProviderHealth> {
    return { ok: true, networkGlobalId: this.networkGlobalId, latencyMs: 1 };
  }
}
