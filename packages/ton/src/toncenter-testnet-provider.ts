import { Address, beginCell, Cell } from '@ton/core';

import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type EnumerateOutgoingJettonTransfersInput,
  type EnumerateOutgoingJettonTransfersResult,
  type EnumeratedOutgoingJettonTransfer,
  type FindTransactionsByQueryIdInput,
  type JettonTransferEvidence,
  type TonAccountBalance,
  type TonChainProvider,
  type TonJettonBalance,
  type TonProviderHealth,
  type TonSendBocResult,
} from './chain-provider.js';
import {
  ENUMERATE_HISTORY_MAX_PAGES,
  buildTransferIdentity,
  finalizeWindowCoverage,
  isoToUnixSeconds,
  resolvePageSize,
  timestampInInclusiveWindow,
  trackObservedBounds,
  unixSecondsToIso,
} from './outgoing-jetton-history.js';
import {
  asRecord,
  assertOkTonCenterBody,
  assertTestnetProviderUrl,
  assertTestnetResponse,
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

/** External-In messages have an empty source and a concrete destination account. */
function isExternalInMessage(message: Record<string, unknown>, hotWallet: string): boolean {
  const source = typeof message.source === 'string' ? message.source.trim() : '';
  if (source !== '') return false;
  return typeof message.destination === 'string' && addressEquals(message.destination, hotWallet);
}

/**
 * Match the persisted Tonkeeper-normalized External-In identity against TonCenter
 * message hash fields returned by getTransactions / index APIs.
 */
function externalInHashMatches(
  message: Record<string, unknown>,
  normalizedExternalMessageHash: string,
): boolean {
  for (const key of ['hash', 'hash_norm', 'message_hash', 'msg_hash'] as const) {
    const value = message[key];
    if (
      typeof value === 'string' &&
      value !== '' &&
      hashEquals(value, normalizedExternalMessageHash)
    ) {
      return true;
    }
  }
  return false;
}

/** Derive Indexed API v3 base URL from a v2 or bare TonCenter base. */
export function deriveTonCenterV3BaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/api/v2')) {
    return `${trimmed.slice(0, -'/api/v2'.length)}/api/v3`;
  }
  if (trimmed.includes('/api/v3')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      return `${url.origin}/api/v3`;
    }
  } catch {
    // fall through to append
  }
  return `${trimmed}/api/v3`;
}

function optionalStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  return null;
}

export class TonCenterTestnetProvider implements TonChainProvider {
  readonly networkGlobalId = TON_TESTNET_NETWORK_GLOBAL_ID;
  private readonly baseUrl: string;
  private readonly v3BaseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TonCenterTestnetProviderConfig) {
    this.baseUrl = assertTestnetProviderUrl(config.baseUrl, 'TonCenterTestnetProvider');
    this.v3BaseUrl = deriveTonCenterV3BaseUrl(this.baseUrl);
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

  private async getV3(pathWithQuery: string, context: string): Promise<Record<string, unknown>> {
    const body = await fetchJson(
      this.fetchImpl,
      `${this.v3BaseUrl}/${pathWithQuery.replace(/^\//, '')}`,
      { method: 'GET', headers: this.headers() },
      context,
    );
    assertTestnetResponse(body, context);
    return asRecord(body, context);
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
      input.normalizedExternalMessageHash === undefined ||
      input.normalizedExternalMessageHash.trim() === '' ||
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
      const externalIn =
        transaction.in_msg === undefined || transaction.in_msg === null
          ? null
          : asRecord(transaction.in_msg, 'TonCenter hot wallet external-in');
      // Chain identity: External-In accepted by the Hot Wallet must match the
      // persisted normalized message hash (no query_id-only confirmation).
      if (
        externalIn === null ||
        !isExternalInMessage(externalIn, input.hotWallet) ||
        !externalInHashMatches(externalIn, input.normalizedExternalMessageHash)
      ) {
        continue;
      }
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

  async enumerateOutgoingJettonTransfers(
    input: EnumerateOutgoingJettonTransfersInput,
  ): Promise<EnumerateOutgoingJettonTransfersResult> {
    const startedAt = new Date().toISOString();
    const pageSize = resolvePageSize(input.pageSize);
    const windowStartUnix = isoToUnixSeconds(input.windowStart, 'windowStart');
    const windowEndUnix = isoToUnixSeconds(input.windowEnd, 'windowEnd');
    if (windowEndUnix < windowStartUnix) {
      throw new Error('MALFORMED_INPUT: windowEnd must be >= windowStart');
    }

    const transfers: EnumeratedOutgoingJettonTransfer[] = [];
    const warnings: string[] = [];
    const observed = { oldest: null as number | null, newest: null as number | null };
    let pagesFetched = 0;
    let recordsSeen = 0;
    let cursorExhausted = false;
    let truncatedBySafety = false;
    let offset = 0;

    while (pagesFetched < ENUMERATE_HISTORY_MAX_PAGES) {
      const params = new URLSearchParams();
      params.set('owner_address', input.hotWalletAddress);
      params.set('jetton_wallet', input.hotWalletJettonWallet);
      params.set('jetton_master', input.jettonMaster);
      params.set('direction', 'out');
      params.set('start_utime', String(windowStartUnix));
      params.set('end_utime', String(windowEndUnix));
      params.set('limit', String(pageSize));
      params.set('offset', String(offset));
      params.set('sort', 'desc');

      const body = await this.getV3(
        `jetton/transfers?${params.toString()}`,
        'TonCenter jetton transfers',
      );
      pagesFetched += 1;

      const rows = Array.isArray(body.jetton_transfers)
        ? body.jetton_transfers
        : Array.isArray(body.transfers)
          ? body.transfers
          : null;
      if (rows === null) {
        throw new Error('MALFORMED_RESPONSE: TonCenter jetton transfers array missing');
      }
      if (rows.length === 0) {
        cursorExhausted = true;
        break;
      }

      let pageOldest: number | null = null;
      for (const raw of rows) {
        const row = asRecord(raw, 'TonCenter jetton transfer');
        recordsSeen += 1;
        const utimeRaw = optionalStringField(row, ['transaction_now', 'utime', 'tx_now', 'now']);
        const utime = utimeRaw === null ? Number.NaN : Number(utimeRaw);
        if (!Number.isFinite(utime)) {
          warnings.push('skipped transfer with invalid utime');
          continue;
        }
        trackObservedBounds(observed, utime);
        if (pageOldest === null || utime < pageOldest) pageOldest = utime;

        const mapped = this.mapOutgoingJettonTransferRow(
          row,
          input,
          utime,
          windowStartUnix,
          windowEndUnix,
        );
        if (mapped !== null) transfers.push(mapped);
      }

      if (pageOldest !== null && pageOldest < windowStartUnix) {
        break;
      }

      if (rows.length < pageSize) {
        cursorExhausted = true;
        break;
      }
      offset += pageSize;
    }

    if (pagesFetched >= ENUMERATE_HISTORY_MAX_PAGES && !cursorExhausted) {
      const reachedPast = observed.oldest !== null && observed.oldest < windowStartUnix;
      if (!reachedPast) {
        truncatedBySafety = true;
        warnings.push(`page cap reached (${ENUMERATE_HISTORY_MAX_PAGES})`);
      }
    }

    const coverage = finalizeWindowCoverage({
      truncatedBySafety,
      cursorExhausted,
      oldestObservedUnix: observed.oldest,
      windowStartUnix,
    });
    const completedAt = new Date().toISOString();
    return {
      providerKind: 'toncenter',
      networkGlobalId: this.networkGlobalId,
      startedAt,
      completedAt,
      requestedWindowStart: input.windowStart,
      requestedWindowEnd: input.windowEnd,
      pagesFetched,
      recordsSeen,
      cursorExhausted,
      windowFullyCovered: coverage.windowFullyCovered,
      oldestObservedTimestamp: observed.oldest === null ? null : unixSecondsToIso(observed.oldest),
      newestObservedTimestamp: observed.newest === null ? null : unixSecondsToIso(observed.newest),
      truncated: coverage.truncated,
      warnings,
      transfers,
    };
  }

  private mapOutgoingJettonTransferRow(
    row: Record<string, unknown>,
    input: EnumerateOutgoingJettonTransfersInput,
    utime: number,
    windowStartUnix: number,
    windowEndUnix: number,
  ): EnumeratedOutgoingJettonTransfer | null {
    if (!timestampInInclusiveWindow(utime, windowStartUnix, windowEndUnix)) return null;

    if (row.aborted === true || row.failed === true || row.success === false) return null;
    if (row.bounced === true) return null;

    const jettonMaster = optionalStringField(row, ['jetton_master', 'jetton', 'master']);
    if (jettonMaster === null || !addressEquals(jettonMaster, input.jettonMaster)) return null;

    const source = optionalStringField(row, ['source', 'source_owner', 'owner_address', 'owner']);
    const senderJettonWallet = optionalStringField(row, [
      'jetton_wallet',
      'source_wallet',
      'sender_jetton_wallet',
      'wallet',
    ]);
    const destination = optionalStringField(row, ['destination', 'destination_owner', 'recipient']);

    const outgoingByOwner = source !== null && addressEquals(source, input.hotWalletAddress);
    const outgoingByWallet =
      senderJettonWallet !== null && addressEquals(senderJettonWallet, input.hotWalletJettonWallet);
    if (!outgoingByOwner && !outgoingByWallet) return null;
    if (destination !== null && addressEquals(destination, input.hotWalletAddress)) return null;
    if (destination === null) return null;

    const amountAtomic = decimalString(
      row.amount ?? row.jetton_amount ?? row.value,
      'TonCenter jetton transfer amount',
    );
    const transactionHash = optionalStringField(row, ['transaction_hash', 'tx_hash', 'hash']);
    const transactionLt = optionalStringField(row, ['transaction_lt', 'tx_lt', 'lt']);
    const queryIdRaw = optionalStringField(row, ['query_id', 'queryId']);
    const queryId = queryIdRaw;
    const traceId = optionalStringField(row, ['trace_id', 'traceId']);

    return {
      providerKind: 'toncenter',
      networkGlobalId: this.networkGlobalId,
      hotWalletAddress: input.hotWalletAddress,
      senderJettonWallet: senderJettonWallet ?? input.hotWalletJettonWallet,
      jettonMaster: input.jettonMaster,
      transactionHash,
      transactionLt,
      queryId,
      amountAtomic,
      recipient: destination,
      timestamp: unixSecondsToIso(utime),
      success: true,
      bounced: false,
      transferIdentity: buildTransferIdentity({
        queryId,
        transactionHash,
        transactionLt,
        amountAtomic,
        recipient: destination,
      }),
      ...(traceId !== null ? { traceId } : {}),
    };
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
