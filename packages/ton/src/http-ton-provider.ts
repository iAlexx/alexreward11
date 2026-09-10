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

export interface HttpTonProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  /** Must be TESTNET (-3). Mainnet (-239) is rejected. */
  readonly networkGlobalId?: number;
  readonly fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
}

/**
 * Thin HTTP JSON-RPC style adapter. Reads base URL + optional API key from config.
 * TESTNET only — rejects mainnet global id -239. No secrets hardcoded.
 */
export class HttpTonProvider implements TonChainProvider {
  readonly networkGlobalId: typeof TON_TESTNET_NETWORK_GLOBAL_ID;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpTonProviderConfig) {
    const networkGlobalId = config.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
    assertTestnetOnly(networkGlobalId);
    const trimmed = config.baseUrl.trim();
    if (trimmed === '') {
      throw new Error('HttpTonProvider requires a non-empty baseUrl');
    }
    this.networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;
    this.baseUrl = trimmed.replace(/\/$/, '');
    this.apiKey = config.apiKey?.trim() ? config.apiKey.trim() : null;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async rpc(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.apiKey !== null) {
      headers['x-api-key'] = this.apiKey;
    }
    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) {
      throw new Error(`TON provider HTTP ${response.status} for ${method}`);
    }
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error !== undefined) {
      throw new Error(body.error.message ?? `TON provider RPC error for ${method}`);
    }
    return body.result;
  }

  async getSeqno(address: string): Promise<number> {
    const result = await this.rpc('getSeqno', { address });
    const seqno = typeof result === 'number' ? result : Number(result);
    if (!Number.isInteger(seqno) || seqno < 0) {
      throw new Error('TON provider returned invalid seqno');
    }
    return seqno;
  }

  async getAccountBalance(address: string): Promise<TonAccountBalance> {
    const result = (await this.rpc('getAccountBalance', { address })) as {
      balance?: string | number;
      balanceNanotons?: string | number;
    };
    const raw = result.balanceNanotons ?? result.balance ?? '0';
    return { address, balanceNanotons: String(raw) };
  }

  async getJettonBalance(ownerAddress: string, jettonMaster: string): Promise<TonJettonBalance> {
    const result = (await this.rpc('getJettonBalance', { ownerAddress, jettonMaster })) as {
      balanceAtomic?: string | number;
      balance?: string | number;
    };
    const raw = result.balanceAtomic ?? result.balance ?? '0';
    return { ownerAddress, jettonMaster, balanceAtomic: String(raw) };
  }

  async sendBoc(bocBase64: string): Promise<TonSendBocResult> {
    const result = (await this.rpc('sendBoc', { boc: bocBase64 })) as {
      accepted?: boolean;
      messageHash?: string;
      providerReference?: string;
    };
    return {
      accepted: result.accepted !== false,
      ...(result.messageHash !== undefined ? { messageHash: result.messageHash } : {}),
      ...(result.providerReference !== undefined
        ? { providerReference: result.providerReference }
        : {}),
    };
  }

  async findTransactionsByQueryId(
    input: FindTransactionsByQueryIdInput,
  ): Promise<readonly JettonTransferEvidence[]> {
    const result = await this.rpc('findTransactionsByQueryId', { ...input });
    if (!Array.isArray(result)) {
      return [];
    }
    return result as JettonTransferEvidence[];
  }

  async observeJettonTransfer(
    input: FindTransactionsByQueryIdInput,
  ): Promise<JettonTransferEvidence | null> {
    const result = await this.rpc('observeJettonTransfer', { ...input });
    if (result === null || result === undefined) {
      return null;
    }
    return result as JettonTransferEvidence;
  }

  async health(): Promise<TonProviderHealth> {
    const started = Date.now();
    try {
      const result = (await this.rpc('health', {})) as {
        ok?: boolean;
        networkGlobalId?: number;
        detail?: string;
      };
      const networkGlobalId = result.networkGlobalId ?? this.networkGlobalId;
      assertTestnetOnly(networkGlobalId);
      return {
        ok: result.ok !== false,
        networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
        latencyMs: Date.now() - started,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        networkGlobalId: this.networkGlobalId,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
