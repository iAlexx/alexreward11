import {
  assertTestnetOnly,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type EnumerateOutgoingJettonTransfersInput,
  type EnumerateOutgoingJettonTransfersResult,
  type EnumeratedOutgoingJettonTransfer,
  type FindTransactionsByQueryIdInput,
  type JettonTransferEvidence,
  type TonAccountBalance,
  type TonAccountState,
  type TonAccountStatus,
  type TonChainProvider,
  type TonJettonBalance,
  type TonProviderHealth,
  type TonSendBocResult,
} from './chain-provider.js';
import { approvedWalletV5R1CodeHash } from './admit-wallet-seqno.js';

export interface FakeTonChainProviderOptions {
  readonly networkGlobalId?: number;
  /** When true, sendBoc throws a timeout-style error after marking submitted. */
  readonly sendBocTimeout?: boolean;
  /** When true, sendBoc throws before any submit side-effect. */
  readonly sendBocFailBeforeSubmit?: boolean;
  /**
   * When true, sendBoc returns accepted:false (ambiguous provider reject).
   * Pipeline must treat as UNKNOWN/RECONCILE_REQUIRED — never BROADCASTED.
   */
  readonly sendBocAcceptedFalse?: boolean;
}

/**
 * Deterministic in-memory fake for unit tests. Not for production paths.
 */
export class FakeTonChainProvider implements TonChainProvider {
  readonly networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;

  private readonly seqnoByAddress = new Map<string, number>();
  private readonly accountStates = new Map<string, TonAccountState>();
  private readonly balances = new Map<string, string>();
  private readonly jettonBalances = new Map<string, string>();
  private readonly transfers: JettonTransferEvidence[] = [];
  private readonly enumeratedTransfers: EnumeratedOutgoingJettonTransfer[] = [];
  private readonly submittedBocs: string[] = [];
  private sendBocTimeout: boolean;
  private sendBocFailBeforeSubmit: boolean;
  private sendBocAcceptedFalse: boolean;
  private sendBocCallCount = 0;
  private seqnoErrorByAddress = new Map<string, Error>();
  private accountStateErrorByAddress = new Map<string, Error>();

  constructor(options: FakeTonChainProviderOptions = {}) {
    assertTestnetOnly(options.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID);
    this.sendBocTimeout = options.sendBocTimeout === true;
    this.sendBocFailBeforeSubmit = options.sendBocFailBeforeSubmit === true;
    this.sendBocAcceptedFalse = options.sendBocAcceptedFalse === true;
  }

  seedSeqno(address: string, seqno: number): void {
    this.seqnoByAddress.set(address, seqno);
  }

  seedAccountState(
    address: string,
    state: {
      readonly status: TonAccountStatus;
      readonly balanceNanotons?: string | null;
      readonly codeHash?: string | null;
      readonly dataHash?: string | null;
      readonly lastTransactionLt?: string | null;
      readonly lastTransactionHash?: string | null;
    },
  ): void {
    this.accountStates.set(address, {
      address,
      status: state.status,
      balanceNanotons: state.balanceNanotons ?? null,
      codeHash: state.codeHash ?? null,
      dataHash: state.dataHash ?? null,
      lastTransactionLt: state.lastTransactionLt ?? null,
      lastTransactionHash: state.lastTransactionHash ?? null,
    });
  }

  /** Seed active verified V5R1 account + seqno for admission tests. */
  seedActiveV5R1(input: {
    readonly address: string;
    readonly seqno: number;
    readonly publicKeyHex: string;
    readonly networkGlobalId?: number;
  }): void {
    const codeHash = approvedWalletV5R1CodeHash({
      publicKeyHex: input.publicKeyHex,
      networkGlobalId: input.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID,
    });
    this.seedSeqno(input.address, input.seqno);
    this.seedAccountState(input.address, {
      status: 'active',
      codeHash,
      balanceNanotons: '1000000000',
    });
  }

  seedUninit(address: string, balanceNanotons = '1000000000'): void {
    this.seedAccountState(address, {
      status: 'uninit',
      balanceNanotons,
      codeHash: null,
    });
  }

  seedSeqnoError(address: string, error: Error): void {
    this.seqnoErrorByAddress.set(address, error);
  }

  seedAccountStateError(address: string, error: Error): void {
    this.accountStateErrorByAddress.set(address, error);
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

  seedEnumeratedOutgoingTransfer(record: EnumeratedOutgoingJettonTransfer): void {
    this.enumeratedTransfers.push(record);
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

  setSendBocAcceptedFalse(value: boolean): void {
    this.sendBocAcceptedFalse = value;
  }

  async getSeqno(address: string): Promise<number> {
    const error = this.seqnoErrorByAddress.get(address);
    if (error !== undefined) throw error;
    return this.seqnoByAddress.get(address) ?? 0;
  }

  async getAccountState(address: string): Promise<TonAccountState> {
    const error = this.accountStateErrorByAddress.get(address);
    if (error !== undefined) throw error;
    const seeded = this.accountStates.get(address);
    if (seeded !== undefined) return seeded;
    if (this.seqnoByAddress.has(address)) {
      return {
        address,
        status: 'active',
        balanceNanotons: this.balances.get(address) ?? '0',
        codeHash: null,
        dataHash: null,
        lastTransactionLt: null,
        lastTransactionHash: null,
      };
    }
    return {
      address,
      status: 'uninit',
      balanceNanotons: this.balances.get(address) ?? '0',
      codeHash: null,
      dataHash: null,
      lastTransactionLt: null,
      lastTransactionHash: null,
    };
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
    if (this.sendBocAcceptedFalse) {
      return {
        accepted: false,
        messageHash: `fake-msg-rejected-${this.submittedBocs.length}`,
        providerReference: `fake-ref-rejected-${this.submittedBocs.length}`,
      };
    }
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

  async enumerateOutgoingJettonTransfers(
    input: EnumerateOutgoingJettonTransfersInput,
  ): Promise<EnumerateOutgoingJettonTransfersResult> {
    const startedAt = new Date().toISOString();
    const windowStartMs = Date.parse(input.windowStart);
    const windowEndMs = Date.parse(input.windowEnd);
    const transfers = this.enumeratedTransfers.filter((record) => {
      if (record.hotWalletAddress !== input.hotWalletAddress) return false;
      if (record.jettonMaster !== input.jettonMaster) return false;
      if (
        record.senderJettonWallet !== null &&
        record.senderJettonWallet !== input.hotWalletJettonWallet
      ) {
        return false;
      }
      if (!record.success || record.bounced) return false;
      const ts = Date.parse(record.timestamp);
      return Number.isFinite(ts) && ts >= windowStartMs && ts <= windowEndMs;
    });
    const timestamps = transfers
      .map((t) => Date.parse(t.timestamp))
      .filter((value) => Number.isFinite(value));
    const oldest = timestamps.length === 0 ? null : new Date(Math.min(...timestamps)).toISOString();
    const newest = timestamps.length === 0 ? null : new Date(Math.max(...timestamps)).toISOString();
    const completedAt = new Date().toISOString();
    return {
      providerKind: 'fake',
      networkGlobalId: this.networkGlobalId,
      startedAt,
      completedAt,
      requestedWindowStart: input.windowStart,
      requestedWindowEnd: input.windowEnd,
      pagesFetched: 1,
      recordsSeen: transfers.length,
      cursorExhausted: true,
      windowFullyCovered: true,
      oldestObservedTimestamp: oldest,
      newestObservedTimestamp: newest,
      truncated: false,
      warnings: [],
      transfers,
    };
  }

  async health(): Promise<TonProviderHealth> {
    return { ok: true, networkGlobalId: this.networkGlobalId, latencyMs: 1 };
  }
}
