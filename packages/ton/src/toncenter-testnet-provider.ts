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
import {
  JETTON_INTERNAL_TRANSFER_OP,
  JETTON_TRANSFER_NOTIFICATION_OP,
  JETTON_TRANSFER_OP,
  parseJettonMessageBase64,
} from './jetton-message-proof.js';

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

function hashEquals(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  try {
    const decode = (value: string): Buffer =>
      /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    return decode(left).equals(decode(right));
  } catch {
    return false;
  }
}

function stackFromResult(result: unknown, context: string): StackEntry[] {
  const record = asRecord(result, context);
  const exitCode = Number(record.exit_code);
  if (exitCode !== 0)
    throw new Error(`TONCENTER_GET_METHOD_FAILED: ${context} exit_code=${exitCode}`);
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

function messageBody(message: Record<string, unknown>): string | null {
  if (message.msg_data === null || typeof message.msg_data !== 'object') return null;
  const body = (message.msg_data as Record<string, unknown>).body;
  return typeof body === 'string' && body !== '' ? body : null;
}

function transactionSucceeded(transaction: Record<string, unknown>): boolean {
  if (transaction.aborted !== false) return false;
  const description = transaction.description;
  if (description === null || typeof description !== 'object' || Array.isArray(description))
    return false;
  const compute = (description as Record<string, unknown>).compute_ph;
  if (compute === null || typeof compute !== 'object' || Array.isArray(compute)) return false;
  const computePhase = compute as Record<string, unknown>;
  if (computePhase.success !== true || Number(computePhase.exit_code) !== 0) return false;
  const action = (description as Record<string, unknown>).action;
  if (action !== undefined) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return false;
    const actionPhase = action as Record<string, unknown>;
    if (actionPhase.success !== true || Number(actionPhase.result_code) !== 0) return false;
  }
  return true;
}

function messages(transaction: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(transaction.out_msgs)) return [];
  return transaction.out_msgs.map((value) => asRecord(value, 'TonCenter out_msg'));
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

  private async runGetMethod(
    address: string,
    method: string,
    stack: unknown[],
  ): Promise<StackEntry[]> {
    const result = await this.post(
      'runGetMethod',
      { address, method, stack },
      `TonCenter runGetMethod ${method}`,
    );
    return stackFromResult(result, `TonCenter ${method}`);
  }

  private async resolveJettonWallet(ownerAddress: string, jettonMaster: string): Promise<string> {
    const ownerCell = beginCell()
      .storeAddress(Address.parse(ownerAddress))
      .endCell()
      .toBoc()
      .toString('base64');
    const walletStack = await this.runGetMethod(jettonMaster, 'get_wallet_address', [
      ['tvm.Slice', ownerCell],
    ]);
    return parseAddressCell(
      stackCellBase64(walletStack[0], 'TonCenter get_wallet_address'),
      'TonCenter get_wallet_address',
    );
  }

  private async proveJettonWalletIdentity(
    walletAddress: string,
    expectedOwner: string,
    expectedMaster: string,
  ): Promise<StackEntry[]> {
    const stack = await this.runGetMethod(walletAddress, 'get_wallet_data', []);
    const owner = parseAddressCell(
      stackCellBase64(stack[1], 'TonCenter get_wallet_data owner'),
      'TonCenter get_wallet_data owner',
    );
    const master = parseAddressCell(
      stackCellBase64(stack[2], 'TonCenter get_wallet_data master'),
      'TonCenter get_wallet_data master',
    );
    if (!addressEquals(owner, expectedOwner) || !addressEquals(master, expectedMaster)) {
      throw new Error('JETTON_WALLET_IDENTITY_MISMATCH: get_wallet_data owner/master mismatch');
    }
    return stack;
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
    const walletAddress = await this.resolveJettonWallet(ownerAddress, jettonMaster);
    const dataStack = await this.proveJettonWalletIdentity(
      walletAddress,
      ownerAddress,
      jettonMaster,
    );
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
    if (
      input.senderJettonWallet === undefined ||
      input.amountAtomic === undefined ||
      input.recipient === undefined
    ) {
      return [];
    }

    const hotResult = await this.get(
      `getTransactions?address=${encodeURIComponent(input.hotWallet)}&limit=50`,
      'TonCenter hot wallet getTransactions',
    );
    if (!Array.isArray(hotResult)) {
      throw new Error('MALFORMED_RESPONSE: TonCenter getTransactions result must be an array');
    }

    let hotTransaction: Record<string, unknown> | null = null;
    let hotTransferMessage: Record<string, unknown> | null = null;
    for (const value of hotResult) {
      const transaction = asRecord(value, 'TonCenter transaction');
      if (!transactionSucceeded(transaction)) continue;
      for (const message of messages(transaction)) {
        const body = messageBody(message);
        const transfer = body === null ? null : parseJettonMessageBase64(body);
        if (
          transfer?.op !== JETTON_TRANSFER_OP ||
          transfer.queryId !== input.queryId ||
          transfer.amountAtomic !== input.amountAtomic ||
          transfer.address === undefined ||
          !addressEquals(transfer.address, input.recipient) ||
          typeof message.source !== 'string' ||
          !addressEquals(message.source, input.hotWallet) ||
          typeof message.destination !== 'string' ||
          !addressEquals(message.destination, input.senderJettonWallet) ||
          message.bounced === true
        ) {
          continue;
        }
        hotTransaction = transaction;
        hotTransferMessage = message;
        break;
      }
      if (hotTransaction !== null) break;
    }
    if (hotTransaction === null || hotTransferMessage === null) return [];

    const resolvedSenderWallet = await this.resolveJettonWallet(
      input.hotWallet,
      input.jettonMaster,
    );
    if (!addressEquals(resolvedSenderWallet, input.senderJettonWallet)) return [];
    await this.proveJettonWalletIdentity(
      input.senderJettonWallet,
      input.hotWallet,
      input.jettonMaster,
    );

    const senderResult = await this.get(
      `getTransactions?address=${encodeURIComponent(input.senderJettonWallet)}&limit=50`,
      'TonCenter sender Jetton wallet getTransactions',
    );
    if (!Array.isArray(senderResult)) {
      throw new Error(
        'MALFORMED_RESPONSE: TonCenter sender getTransactions result must be an array',
      );
    }
    const rootUtime = Number(hotTransaction.utime);
    let senderTransaction: Record<string, unknown> | null = null;
    let internalTransferMessage: Record<string, unknown> | null = null;
    for (const value of senderResult) {
      const transaction = asRecord(value, 'TonCenter sender Jetton wallet transaction');
      const incoming = asRecord(
        transaction.in_msg,
        'TonCenter sender Jetton wallet transaction in_msg',
      );
      const incomingBody = messageBody(incoming);
      const transfer = incomingBody === null ? null : parseJettonMessageBase64(incomingBody);
      const correlatedHash =
        typeof hotTransferMessage.body_hash === 'string' &&
        typeof incoming.body_hash === 'string' &&
        hotTransferMessage.body_hash !== ''
          ? hashEquals(hotTransferMessage.body_hash, incoming.body_hash)
          : true;
      const correlatedTime =
        !Number.isFinite(rootUtime) ||
        !Number.isFinite(Number(transaction.utime)) ||
        Math.abs(Number(transaction.utime) - rootUtime) <= 120;
      if (
        !transactionSucceeded(transaction) ||
        incoming.bounced === true ||
        typeof incoming.source !== 'string' ||
        !addressEquals(incoming.source, input.hotWallet) ||
        typeof incoming.destination !== 'string' ||
        !addressEquals(incoming.destination, input.senderJettonWallet) ||
        transfer?.op !== JETTON_TRANSFER_OP ||
        transfer.queryId !== input.queryId ||
        transfer.amountAtomic !== input.amountAtomic ||
        !correlatedHash ||
        !correlatedTime
      ) {
        continue;
      }
      const internal = messages(transaction).find((message) => {
        const body = messageBody(message);
        const parsed = body === null ? null : parseJettonMessageBase64(body);
        return (
          message.bounced !== true &&
          parsed?.op === JETTON_INTERNAL_TRANSFER_OP &&
          parsed.queryId === input.queryId &&
          parsed.amountAtomic === input.amountAtomic &&
          parsed.address !== undefined &&
          addressEquals(parsed.address, input.hotWallet)
        );
      });
      if (internal !== undefined) {
        senderTransaction = transaction;
        internalTransferMessage = internal;
        break;
      }
    }
    if (senderTransaction === null || internalTransferMessage === null) return [];

    const recipientWallet = await this.resolveJettonWallet(input.recipient, input.jettonMaster);
    if (
      typeof internalTransferMessage.destination !== 'string' ||
      !addressEquals(internalTransferMessage.destination, recipientWallet)
    ) {
      return [];
    }
    await this.proveJettonWalletIdentity(recipientWallet, input.recipient, input.jettonMaster);

    const recipientResult = await this.get(
      `getTransactions?address=${encodeURIComponent(recipientWallet)}&limit=50`,
      'TonCenter recipient Jetton wallet getTransactions',
    );
    if (!Array.isArray(recipientResult)) {
      throw new Error(
        'MALFORMED_RESPONSE: TonCenter recipient getTransactions result must be an array',
      );
    }
    let recipientTransaction: Record<string, unknown> | null = null;
    for (const value of recipientResult) {
      const transaction = asRecord(value, 'TonCenter recipient Jetton wallet transaction');
      const incoming = asRecord(
        transaction.in_msg,
        'TonCenter recipient Jetton wallet transaction in_msg',
      );
      const body = messageBody(incoming);
      const internal = body === null ? null : parseJettonMessageBase64(body);
      const correlatedHash =
        typeof internalTransferMessage.body_hash === 'string' &&
        typeof incoming.body_hash === 'string' &&
        internalTransferMessage.body_hash !== ''
          ? hashEquals(internalTransferMessage.body_hash, incoming.body_hash)
          : true;
      if (
        !transactionSucceeded(transaction) ||
        incoming.bounced === true ||
        typeof incoming.source !== 'string' ||
        !addressEquals(incoming.source, input.senderJettonWallet) ||
        typeof incoming.destination !== 'string' ||
        !addressEquals(incoming.destination, recipientWallet) ||
        internal?.op !== JETTON_INTERNAL_TRANSFER_OP ||
        internal.queryId !== input.queryId ||
        internal.amountAtomic !== input.amountAtomic ||
        internal.address === undefined ||
        !addressEquals(internal.address, input.hotWallet) ||
        !correlatedHash
      ) {
        continue;
      }
      const notification = messages(transaction).find((message) => {
        const notificationBody = messageBody(message);
        const parsed =
          notificationBody === null ? null : parseJettonMessageBase64(notificationBody);
        return (
          message.bounced !== true &&
          typeof message.destination === 'string' &&
          addressEquals(message.destination, input.recipient!) &&
          parsed?.op === JETTON_TRANSFER_NOTIFICATION_OP &&
          parsed.queryId === input.queryId &&
          parsed.amountAtomic === input.amountAtomic &&
          parsed.address !== undefined &&
          addressEquals(parsed.address, input.hotWallet)
        );
      });
      if (notification !== undefined) {
        recipientTransaction = transaction;
        break;
      }
    }
    if (recipientTransaction === null) return [];

    const hotId = asRecord(hotTransaction.transaction_id, 'TonCenter hot transaction_id');
    const senderId = asRecord(senderTransaction.transaction_id, 'TonCenter sender transaction_id');
    const recipientId = asRecord(
      recipientTransaction.transaction_id,
      'TonCenter recipient transaction_id',
    );
    if (typeof hotId.hash !== 'string' || typeof senderId.hash !== 'string') {
      throw new Error('MALFORMED_RESPONSE: TonCenter proof transaction hash missing');
    }
    return [
      {
        hotWallet: input.hotWallet,
        jettonMaster: input.jettonMaster,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        queryId: input.queryId,
        success: true,
        bounced: false,
        transactionHash: hotId.hash,
        hotWalletTxHash: hotId.hash,
        jettonWalletTxHash: senderId.hash,
        recipientEvidence:
          typeof recipientId.hash === 'string'
            ? recipientId.hash
            : `recipient-wallet:${recipientWallet}`,
        proofStage: 'COMPLETE',
        ...(typeof hotId.lt === 'string' ? { lt: hotId.lt } : {}),
        networkGlobalId: this.networkGlobalId,
        senderJettonWallet: input.senderJettonWallet,
        providerKind: 'toncenter',
      },
    ];
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
