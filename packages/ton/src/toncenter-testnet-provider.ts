import { Address, beginCell, Cell } from '@ton/core';

import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type FindTransactionsByQueryIdInput,
  type JettonTransferEvidence,
  type TonAccountBalance,
  type TonChainProvider,
  type TonJettonBalance,
  type TonProviderHealth,
  type TonSendBocResult,
} from './chain-provider.js';
import {
  asRecord,
  assertOkTonCenterBody,
  assertTestnetProviderUrl,
  decimalString,
  fetchJson,
  parseStackNumber,
} from './provider-http.js';

export interface TonCenterTestnetProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
}

type StackEntry = readonly [unknown, unknown];

function addressEquals(left: string, right: string): boolean {
  try {
    return Address.parse(left).equals(Address.parse(right));
  } catch {
    return left === right;
  }
}

function stackFromResult(result: unknown, context: string): StackEntry[] {
  const record = asRecord(result, context);
  const exitCode = Number(record.exit_code);
  if (exitCode !== 0) throw new Error(`TONCENTER_GET_METHOD_FAILED: ${context} exit_code=${exitCode}`);
  if (!Array.isArray(record.stack)) {
    throw new Error(`MALFORMED_RESPONSE: ${context} stack missing`);
  }
  return record.stack as StackEntry[];
}

function stackCellBase64(entry: StackEntry | undefined, context: string): string {
  if (!Array.isArray(entry)) throw new Error(`MALFORMED_RESPONSE: ${context} cell missing`);
  const value = entry[1];
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const bytes = (value as Record<string, unknown>).bytes;
    if (typeof bytes === 'string') return bytes;
  }
  throw new Error(`MALFORMED_RESPONSE: ${context} cell bytes missing`);
}

function parseAddressCell(base64: string, context: string): string {
  try {
    const roots = Cell.fromBase64(base64);
    const address = roots.beginParse().loadAddress();
    if (address === null) throw new Error('null address');
    return address.toString();
  } catch (error) {
    throw new Error(
      `MALFORMED_RESPONSE: ${context} contains an invalid address cell: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function parseJettonTransferBody(body: string): {
  queryId: string;
  amountAtomic: string;
  recipient: string;
} | null {
  try {
    const slice = Cell.fromBase64(body).beginParse();
    if (slice.loadUint(32) !== 0x0f8a7ea5) return null;
    const queryId = slice.loadUintBig(64).toString(10);
    const amountAtomic = slice.loadCoins().toString(10);
    const recipient = slice.loadAddress();
    if (recipient === null) return null;
    return { queryId, amountAtomic, recipient: recipient.toString() };
  } catch {
    return null;
  }
}

export class TonCenterTestnetProvider implements TonChainProvider {
  readonly networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TonCenterTestnetProviderConfig) {
    this.baseUrl = assertTestnetProviderUrl(config.baseUrl, 'TonCenterTestnetProvider');
    this.apiKey = config.apiKey?.trim() ? config.apiKey.trim() : null;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
    if (this.apiKey !== null) headers['X-API-Key'] = this.apiKey;
    return headers;
  }

  private async get(path: string, context: string): Promise<unknown> {
    const body = await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${path}`,
      { method: 'GET', headers: this.headers() },
      context,
    );
    assertOkTonCenterBody(body, context);
    return body.result;
  }

  private async post(path: string, payload: unknown, context: string): Promise<unknown> {
    const body = await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/${path}`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) },
      context,
    );
    assertOkTonCenterBody(body, context);
    return body.result;
  }

  private async runGetMethod(address: string, method: string, stack: unknown[]): Promise<StackEntry[]> {
    const result = await this.post(
      'runGetMethod',
      { address, method, stack },
      `TonCenter runGetMethod ${method}`,
    );
    return stackFromResult(result, `TonCenter ${method}`);
  }

  async getSeqno(address: string): Promise<number> {
    const stack = await this.runGetMethod(address, 'seqno', []);
    const value = parseStackNumber(stack[0], 'TonCenter seqno');
    const seqno = Number(value);
    if (!Number.isSafeInteger(seqno) || seqno < 0) {
      throw new Error('MALFORMED_RESPONSE: TonCenter seqno is invalid');
    }
    return seqno;
  }

  async getAccountBalance(address: string): Promise<TonAccountBalance> {
    const result = await this.get(
      `getAddressBalance?address=${encodeURIComponent(address)}`,
      'TonCenter getAddressBalance',
    );
    return {
      address,
      balanceNanotons: decimalString(result, 'TonCenter account balance'),
    };
  }

  async getJettonBalance(ownerAddress: string, jettonMaster: string): Promise<TonJettonBalance> {
    const ownerCell = beginCell().storeAddress(Address.parse(ownerAddress)).endCell().toBoc().toString('base64');
    const walletStack = await this.runGetMethod(
      jettonMaster,
      'get_wallet_address',
      [['tvm.Slice', ownerCell]],
    );
    const walletAddress = parseAddressCell(
      stackCellBase64(walletStack[0], 'TonCenter get_wallet_address'),
      'TonCenter get_wallet_address',
    );
    const dataStack = await this.runGetMethod(walletAddress, 'get_wallet_data', []);
    return {
      ownerAddress,
      jettonMaster,
      balanceAtomic: parseStackNumber(dataStack[0], 'TonCenter get_wallet_data balance'),
    };
  }

  async sendBoc(bocBase64: string): Promise<TonSendBocResult> {
    const result = asRecord(
      await this.post('sendBocReturnHash', { boc: bocBase64 }, 'TonCenter sendBocReturnHash'),
      'TonCenter sendBocReturnHash result',
    );
    if (typeof result.hash !== 'string' || result.hash === '') {
      throw new Error('MALFORMED_RESPONSE: TonCenter sendBocReturnHash hash missing');
    }
    return {
      accepted: true,
      messageHash: result.hash,
      providerReference: result.hash,
    };
  }

  async findTransactionsByQueryId(
    input: FindTransactionsByQueryIdInput,
  ): Promise<readonly JettonTransferEvidence[]> {
    const result = await this.get(
      `getTransactions?address=${encodeURIComponent(input.hotWallet)}&limit=50`,
      'TonCenter getTransactions',
    );
    if (!Array.isArray(result)) {
      throw new Error('MALFORMED_RESPONSE: TonCenter getTransactions result must be an array');
    }

    const evidence: JettonTransferEvidence[] = [];
    for (const value of result) {
      const transaction = asRecord(value, 'TonCenter transaction');
      const transactionId = asRecord(transaction.transaction_id, 'TonCenter transaction_id');
      const outMessages = transaction.out_msgs;
      if (!Array.isArray(outMessages)) continue;
      for (const rawMessage of outMessages) {
        const message = asRecord(rawMessage, 'TonCenter out_msg');
        const msgData = asRecord(message.msg_data, 'TonCenter out_msg.msg_data');
        if (typeof msgData.body !== 'string') continue;
        const transfer = parseJettonTransferBody(msgData.body);
        if (transfer === null || transfer.queryId !== input.queryId) continue;
        if (input.recipient !== undefined && !addressEquals(transfer.recipient, input.recipient)) continue;
        const bounced = message.bounced === true;
        evidence.push({
          hotWallet: input.hotWallet,
          jettonMaster: input.jettonMaster,
          recipient: transfer.recipient,
          amountAtomic: transfer.amountAtomic,
          queryId: transfer.queryId,
          success: !bounced,
          bounced,
          ...(typeof transactionId.hash === 'string' ? { transactionHash: transactionId.hash } : {}),
          ...(typeof transactionId.lt === 'string' ? { lt: transactionId.lt } : {}),
          networkGlobalId: this.networkGlobalId,
          ...(typeof message.destination === 'string'
            ? { senderJettonWallet: message.destination }
            : {}),
          providerKind: 'toncenter',
        });
      }
    }
    return evidence;
  }

  async observeJettonTransfer(
    input: FindTransactionsByQueryIdInput,
  ): Promise<JettonTransferEvidence | null> {
    return (await this.findTransactionsByQueryId(input))[0] ?? null;
  }

  async health(): Promise<TonProviderHealth> {
    const started = Date.now();
    try {
      const result = await this.get('getMasterchainInfo', 'TonCenter getMasterchainInfo');
      asRecord(result, 'TonCenter masterchain info');
      return {
        ok: true,
        networkGlobalId: this.networkGlobalId,
        latencyMs: Date.now() - started,
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
