import { Address } from '@ton/core';

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
  assertTestnetProviderUrl,
  assertTestnetResponse,
  decimalString,
  fetchJson,
  fetchOk,
} from './provider-http.js';
import {
  JETTON_INTERNAL_TRANSFER_OP,
  JETTON_TRANSFER_NOTIFICATION_OP,
  JETTON_TRANSFER_OP,
  parseJettonMessageHex,
} from './jetton-message-proof.js';

export interface TonApiTestnetProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
}

function addressValue(value: unknown, context: string): string {
  if (typeof value === 'string' && value !== '') return value;
  const record = asRecord(value, context);
  if (typeof record.address !== 'string' || record.address === '') {
    throw new Error(`MALFORMED_RESPONSE: ${context}.address missing`);
  }
  return record.address;
}

function addressEquals(left: string, right: string): boolean {
  try {
    return Address.parse(left).equals(Address.parse(right));
  } catch {
    return left === right;
  }
}

function optionalAddress(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const address = (value as Record<string, unknown>).address;
  return typeof address === 'string' && address !== '' ? address : null;
}

function transactionSucceeded(transaction: Record<string, unknown>): boolean {
  if (transaction.success !== true || transaction.aborted !== false) return false;
  const compute = transaction.compute_phase;
  if (compute === null || typeof compute !== 'object' || Array.isArray(compute)) return false;
  const phase = compute as Record<string, unknown>;
  if (phase.skipped !== false || phase.success !== true || Number(phase.exit_code) !== 0)
    return false;
  const action = transaction.action_phase;
  if (action !== undefined) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return false;
    const actionPhase = action as Record<string, unknown>;
    if (actionPhase.success !== true || Number(actionPhase.result_code) !== 0) return false;
  }
  return true;
}

function messageBody(message: Record<string, unknown>): string | null {
  return typeof message.raw_body === 'string' && message.raw_body !== '' ? message.raw_body : null;
}

function transactionMessages(
  transaction: Record<string, unknown>,
  field: 'out_msgs',
): Record<string, unknown>[] {
  const value = transaction[field];
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item, `TonAPI transaction.${field}`));
}

function flattenTrace(
  trace: Record<string, unknown>,
): Array<{ transaction: Record<string, unknown>; trace: Record<string, unknown> }> {
  const result = [{ transaction: asRecord(trace.transaction, 'TonAPI trace transaction'), trace }];
  if (Array.isArray(trace.children)) {
    for (const child of trace.children) {
      result.push(...flattenTrace(asRecord(child, 'TonAPI child trace')));
    }
  }
  return result;
}

export class TonApiTestnetProvider implements TonChainProvider {
  readonly networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TonApiTestnetProviderConfig) {
    this.baseUrl = assertTestnetProviderUrl(config.baseUrl, 'TonApiTestnetProvider');
    this.apiKey = config.apiKey?.trim() ? config.apiKey.trim() : null;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
    if (this.apiKey !== null) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async get(path: string, context: string): Promise<Record<string, unknown>> {
    const body = await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      { method: 'GET', headers: this.headers() },
      context,
    );
    assertTestnetResponse(body, context);
    return asRecord(body, context);
  }

  async getSeqno(address: string): Promise<number> {
    const body = await this.get(
      `/v2/wallet/${encodeURIComponent(address)}/seqno`,
      'TonAPI wallet seqno',
    );
    const seqno = Number(body.seqno);
    if (!Number.isSafeInteger(seqno) || seqno < 0) {
      throw new Error('MALFORMED_RESPONSE: TonAPI seqno is invalid');
    }
    return seqno;
  }

  async getAccountBalance(address: string): Promise<TonAccountBalance> {
    const body = await this.get(`/v2/accounts/${encodeURIComponent(address)}`, 'TonAPI account');
    return {
      address,
      balanceNanotons: decimalString(body.balance, 'TonAPI account balance'),
    };
  }

  async getJettonBalance(ownerAddress: string, jettonMaster: string): Promise<TonJettonBalance> {
    const body = await this.get(
      `/v2/accounts/${encodeURIComponent(ownerAddress)}/jettons/${encodeURIComponent(jettonMaster)}`,
      'TonAPI jetton balance',
    );
    const returnedMaster = addressValue(body.jetton, 'TonAPI jetton');
    addressValue(body.wallet_address, 'TonAPI jetton wallet');
    if (!addressEquals(returnedMaster, jettonMaster)) {
      throw new Error('MALFORMED_RESPONSE: TonAPI returned a different jetton master');
    }
    return {
      ownerAddress,
      jettonMaster,
      balanceAtomic: decimalString(body.balance, 'TonAPI jetton balance'),
    };
  }

  private async resolveJettonWallet(owner: string, jettonMaster: string): Promise<string> {
    const body = await this.get(
      `/v2/accounts/${encodeURIComponent(owner)}/jettons/${encodeURIComponent(jettonMaster)}`,
      'TonAPI account jetton wallet',
    );
    const returnedMaster = addressValue(body.jetton, 'TonAPI jetton');
    const walletAddress = addressValue(body.wallet_address, 'TonAPI jetton wallet');
    if (!addressEquals(returnedMaster, jettonMaster)) {
      throw new Error('MALFORMED_RESPONSE: TonAPI returned a different jetton master');
    }
    return walletAddress;
  }

  async sendBoc(bocBase64: string): Promise<TonSendBocResult> {
    await fetchOk(
      this.fetchImpl,
      `${this.baseUrl}/v2/blockchain/message`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ boc: bocBase64 }),
      },
      'TonAPI blockchain message',
    );
    return { accepted: true, providerReference: 'tonapi:v2:blockchain/message' };
  }

  async findTransactionsByQueryId(
    input: FindTransactionsByQueryIdInput,
  ): Promise<readonly JettonTransferEvidence[]> {
    if (
      input.normalizedExternalMessageHash === undefined ||
      input.senderJettonWallet === undefined ||
      input.amountAtomic === undefined ||
      input.recipient === undefined
    ) {
      return [];
    }

    const hotTransaction = await this.get(
      `/v2/blockchain/messages/${encodeURIComponent(input.normalizedExternalMessageHash)}/transaction`,
      'TonAPI transaction by message hash',
    );
    const hotAccount = optionalAddress(hotTransaction.account);
    const externalIn =
      hotTransaction.in_msg === undefined
        ? null
        : asRecord(hotTransaction.in_msg, 'TonAPI external-in message');
    if (
      hotAccount === null ||
      !addressEquals(hotAccount, input.hotWallet) ||
      externalIn === null ||
      externalIn.msg_type !== 'ext_in_msg' ||
      optionalAddress(externalIn.destination) === null ||
      !addressEquals(optionalAddress(externalIn.destination)!, input.hotWallet) ||
      !transactionSucceeded(hotTransaction)
    ) {
      return [];
    }

    const expectedTransfer = (message: Record<string, unknown>): boolean => {
      const body = messageBody(message);
      if (
        body === null ||
        message.msg_type !== 'int_msg' ||
        message.bounced === true ||
        optionalAddress(message.source) === null ||
        !addressEquals(optionalAddress(message.source)!, input.hotWallet) ||
        optionalAddress(message.destination) === null ||
        !addressEquals(optionalAddress(message.destination)!, input.senderJettonWallet!)
      ) {
        return false;
      }
      const parsed = parseJettonMessageHex(body);
      return (
        parsed?.op === JETTON_TRANSFER_OP &&
        parsed.queryId === input.queryId &&
        parsed.amountAtomic === input.amountAtomic &&
        parsed.address !== undefined &&
        addressEquals(parsed.address, input.recipient!)
      );
    };
    if (!transactionMessages(hotTransaction, 'out_msgs').some(expectedTransfer)) return [];

    const provedSenderWallet = await this.resolveJettonWallet(input.hotWallet, input.jettonMaster);
    if (!addressEquals(provedSenderWallet, input.senderJettonWallet)) return [];
    const recipientWallet = await this.resolveJettonWallet(input.recipient, input.jettonMaster);

    const hotHash =
      typeof hotTransaction.hash === 'string' && hotTransaction.hash !== ''
        ? hotTransaction.hash
        : null;
    if (hotHash === null) {
      throw new Error('MALFORMED_RESPONSE: TonAPI transaction hash missing');
    }
    const trace = await this.get(`/v2/traces/${encodeURIComponent(hotHash)}`, 'TonAPI trace');
    const traceNodes = flattenTrace(trace);
    const senderNode = traceNodes.find(({ transaction }) => {
      const account = optionalAddress(transaction.account);
      const incoming =
        transaction.in_msg === undefined
          ? null
          : asRecord(transaction.in_msg, 'TonAPI sender Jetton wallet in_msg');
      return (
        account !== null &&
        addressEquals(account, input.senderJettonWallet!) &&
        incoming !== null &&
        expectedTransfer(incoming) &&
        transactionSucceeded(transaction)
      );
    });
    if (senderNode === undefined) return [];

    const senderTxHash =
      typeof senderNode.transaction.hash === 'string' ? senderNode.transaction.hash : null;
    if (senderTxHash === null) {
      throw new Error('MALFORMED_RESPONSE: TonAPI sender Jetton wallet transaction hash missing');
    }

    const recipientNode = flattenTrace(senderNode.trace).find(({ transaction }) => {
      const account = optionalAddress(transaction.account);
      const incoming =
        transaction.in_msg === undefined
          ? null
          : asRecord(transaction.in_msg, 'TonAPI recipient Jetton wallet in_msg');
      if (
        account === null ||
        !addressEquals(account, recipientWallet) ||
        incoming === null ||
        incoming.bounced === true ||
        optionalAddress(incoming.source) === null ||
        !addressEquals(optionalAddress(incoming.source)!, input.senderJettonWallet!) ||
        optionalAddress(incoming.destination) === null ||
        !addressEquals(optionalAddress(incoming.destination)!, recipientWallet) ||
        !transactionSucceeded(transaction)
      ) {
        return false;
      }
      const incomingBody = messageBody(incoming);
      const internal = incomingBody === null ? null : parseJettonMessageHex(incomingBody);
      if (
        internal?.op !== JETTON_INTERNAL_TRANSFER_OP ||
        internal.queryId !== input.queryId ||
        internal.amountAtomic !== input.amountAtomic ||
        internal.address === undefined ||
        !addressEquals(internal.address, input.hotWallet)
      ) {
        return false;
      }
      return transactionMessages(transaction, 'out_msgs').some((message) => {
        const body = messageBody(message);
        const notification = body === null ? null : parseJettonMessageHex(body);
        const destination = optionalAddress(message.destination);
        return (
          message.msg_type === 'int_msg' &&
          message.bounced !== true &&
          destination !== null &&
          addressEquals(destination, input.recipient!) &&
          notification?.op === JETTON_TRANSFER_NOTIFICATION_OP &&
          notification.queryId === input.queryId &&
          notification.amountAtomic === input.amountAtomic &&
          notification.address !== undefined &&
          addressEquals(notification.address, input.hotWallet)
        );
      });
    });
    if (recipientNode === undefined) return [];

    const recipientTxHash =
      typeof recipientNode.transaction.hash === 'string'
        ? recipientNode.transaction.hash
        : 'recipient-jetton-wallet-transaction';
    return [
      {
        hotWallet: input.hotWallet,
        jettonMaster: input.jettonMaster,
        recipient: input.recipient,
        amountAtomic: input.amountAtomic,
        queryId: input.queryId,
        success: true,
        bounced: false,
        transactionHash: hotHash,
        hotWalletTxHash: hotHash,
        jettonWalletTxHash: senderTxHash,
        recipientEvidence: recipientTxHash,
        traceId: hotHash,
        proofStage: 'COMPLETE',
        ...(typeof hotTransaction.lt === 'string' || typeof hotTransaction.lt === 'number'
          ? { lt: String(hotTransaction.lt) }
          : {}),
        networkGlobalId: this.networkGlobalId,
        senderJettonWallet: input.senderJettonWallet,
        providerKind: 'tonapi',
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
      const body = await this.get('/v2/status', 'TonAPI status');
      if (body.rest_online !== true) {
        throw new Error('TonAPI REST API is offline');
      }
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
