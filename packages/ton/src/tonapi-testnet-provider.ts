import { Address } from '@ton/core';

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

function normalizeAddressKey(value: string): string {
  try {
    return Address.parse(value).toRawString().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
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

/**
 * Collect candidate tx hashes from TonAPI history events/actions/operations.
 * Labels are discovery-only — never sufficient for PROVIDER inclusion.
 */
function collectJettonTransferCandidateHashes(body: Record<string, unknown>): string[] {
  const hashes = new Set<string>();
  const considerAction = (action: Record<string, unknown>): void => {
    const type = typeof action.type === 'string' ? action.type : '';
    const status = typeof action.status === 'string' ? action.status : '';
    const looksLikeTransfer =
      /jetton.?transfer/i.test(type) ||
      action.operation === 'transfer' ||
      type === 'JettonTransfer';
    if (!looksLikeTransfer) return;
    if (status !== '' && status.toLowerCase() !== 'ok') return;
    for (const key of ['transaction_hash', 'event_id', 'hash'] as const) {
      const value = action[key];
      if (typeof value === 'string' && value !== '') hashes.add(value);
    }
  };
  if (Array.isArray(body.events)) {
    for (const rawEvent of body.events) {
      const event = asRecord(rawEvent, 'TonAPI history event');
      if (typeof event.event_id === 'string' && event.event_id !== '') hashes.add(event.event_id);
      if (Array.isArray(event.actions)) {
        for (const rawAction of event.actions) {
          considerAction(asRecord(rawAction, 'TonAPI history action'));
        }
      }
    }
  }
  if (Array.isArray(body.operations)) {
    for (const rawOp of body.operations) {
      const op = asRecord(rawOp, 'TonAPI history operation');
      considerAction(op);
      if (typeof op.transaction_hash === 'string' && op.transaction_hash !== '') {
        hashes.add(op.transaction_hash);
      }
    }
  }
  if (Array.isArray(body.actions)) {
    for (const rawAction of body.actions) {
      considerAction(asRecord(rawAction, 'TonAPI history action'));
    }
  }
  return [...hashes];
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
    const includedHashes = new Set<string>();
    const recipientWalletCache = new Map<string, string | null>();
    let pagesFetched = 0;
    let recordsSeen = 0;
    let cursorExhausted = false;
    let truncatedBySafety = false;
    let beforeLt: string | undefined;

    // Authoritative jetton-wallet binding must match input before any transfer is accepted.
    const provedHotJettonWallet = await this.resolveJettonWallet(
      input.hotWalletAddress,
      input.jettonMaster,
    );
    const hotWalletBindingOk = addressEquals(provedHotJettonWallet, input.hotWalletJettonWallet);
    if (!hotWalletBindingOk) {
      warnings.push(
        'resolveJettonWallet(hotWallet, jettonMaster) does not equal hotWalletJettonWallet; refusing all transfers',
      );
    }

    while (pagesFetched < ENUMERATE_HISTORY_MAX_PAGES) {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('sort_order', 'desc');
      if (beforeLt !== undefined) params.set('before_lt', beforeLt);

      const path =
        `/v2/blockchain/accounts/${encodeURIComponent(input.hotWalletJettonWallet)}` +
        `/transactions?${params.toString()}`;
      const body = await this.get(path, 'TonAPI blockchain account transactions');
      pagesFetched += 1;

      if (!Array.isArray(body.transactions)) {
        throw new Error('MALFORMED_RESPONSE: TonAPI blockchain transactions missing');
      }
      const transactions = body.transactions;
      if (transactions.length === 0) {
        cursorExhausted = true;
        break;
      }

      let pageOldestUtime: number | null = null;
      let pageOldestLt: string | null = null;
      for (const raw of transactions) {
        const transaction = asRecord(raw, 'TonAPI blockchain transaction');
        recordsSeen += 1;
        const utime = Number(transaction.utime);
        if (!Number.isFinite(utime)) {
          warnings.push('skipped transaction with invalid utime');
          continue;
        }
        trackObservedBounds(observed, utime);
        if (pageOldestUtime === null || utime < pageOldestUtime) pageOldestUtime = utime;

        const lt =
          typeof transaction.lt === 'string' || typeof transaction.lt === 'number'
            ? String(transaction.lt)
            : null;
        if (lt !== null && (pageOldestLt === null || BigInt(lt) < BigInt(pageOldestLt))) {
          pageOldestLt = lt;
        }

        if (!hotWalletBindingOk) continue;

        const proved = await this.proveOutgoingJettonTransferFromRawTransaction(
          transaction,
          input,
          recipientWalletCache,
          warnings,
        );
        if (proved === null) continue;
        if (!timestampInInclusiveWindow(utime, windowStartUnix, windowEndUnix)) continue;
        if (proved.transactionHash !== null) includedHashes.add(proved.transactionHash);
        transfers.push(proved);
      }

      if (pageOldestUtime !== null && pageOldestUtime < windowStartUnix) {
        break;
      }

      if (pageOldestLt === null || pageOldestLt === '' || pageOldestLt === '0') {
        cursorExhausted = true;
        break;
      }
      if (beforeLt !== undefined && pageOldestLt === beforeLt) {
        warnings.push('cursor repetition: before_lt did not advance');
        truncatedBySafety = true;
        break;
      }
      if (transactions.length < pageSize) {
        cursorExhausted = true;
        break;
      }
      beforeLt = pageOldestLt;
    }

    if (pagesFetched >= ENUMERATE_HISTORY_MAX_PAGES && !cursorExhausted) {
      const reachedPast = observed.oldest !== null && observed.oldest < windowStartUnix;
      if (!reachedPast) {
        truncatedBySafety = true;
        warnings.push(`page cap reached (${ENUMERATE_HISTORY_MAX_PAGES})`);
      }
    }

    // Optional discovery: events/actions may suggest candidate hashes only.
    // Every included transfer must still pass raw TEP-74 proof.
    await this.discoverOutgoingCandidatesFromJettonHistory(
      input,
      windowStartUnix,
      windowEndUnix,
      observed,
      includedHashes,
      recipientWalletCache,
      transfers,
      warnings,
      hotWalletBindingOk,
    );

    const coverage = finalizeWindowCoverage({
      truncatedBySafety,
      cursorExhausted,
      oldestObservedUnix: observed.oldest,
      windowStartUnix,
    });
    const completedAt = new Date().toISOString();
    return {
      providerKind: 'tonapi',
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

  /**
   * Optional history discovery. Collects candidate transaction hashes from
   * events/actions (JettonTransfer labels) and includes them ONLY when raw
   * blockchain transaction proof succeeds. Action labels alone never produce
   * PROVIDER transfers.
   */
  private async discoverOutgoingCandidatesFromJettonHistory(
    input: EnumerateOutgoingJettonTransfersInput,
    windowStartUnix: number,
    windowEndUnix: number,
    observed: { oldest: number | null; newest: number | null },
    includedHashes: Set<string>,
    recipientWalletCache: Map<string, string | null>,
    transfers: EnumeratedOutgoingJettonTransfer[],
    warnings: string[],
    hotWalletBindingOk: boolean,
  ): Promise<void> {
    if (!hotWalletBindingOk) return;

    let beforeLt: string | undefined;
    let discoveryPages = 0;
    while (discoveryPages < ENUMERATE_HISTORY_MAX_PAGES) {
      const params = new URLSearchParams();
      params.set('limit', '100');
      params.set('start_date', String(windowStartUnix));
      params.set('end_date', String(windowEndUnix));
      if (beforeLt !== undefined) params.set('before_lt', beforeLt);

      const path =
        `/v2/accounts/${encodeURIComponent(input.hotWalletAddress)}` +
        `/jettons/${encodeURIComponent(input.jettonMaster)}/history?${params.toString()}`;

      let body: Record<string, unknown>;
      try {
        body = await this.get(path, 'TonAPI jetton history discovery');
      } catch (error) {
        warnings.push(
          `jetton history discovery skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      discoveryPages += 1;

      const candidateHashes = collectJettonTransferCandidateHashes(body);
      for (const hash of candidateHashes) {
        if (includedHashes.has(hash)) continue;
        let transactionBody: Record<string, unknown>;
        try {
          transactionBody = await this.get(
            `/v2/blockchain/transactions/${encodeURIComponent(hash)}`,
            'TonAPI blockchain transaction by hash',
          );
        } catch (error) {
          warnings.push(
            `action candidate ${hash} raw fetch failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        const utime = Number(transactionBody.utime);
        if (Number.isFinite(utime)) trackObservedBounds(observed, utime);
        const proved = await this.proveOutgoingJettonTransferFromRawTransaction(
          transactionBody,
          input,
          recipientWalletCache,
          warnings,
          `action-claimed ${hash}`,
        );
        if (proved === null) {
          warnings.push(`action claimed JettonTransfer but raw proof failed for ${hash}; skipped`);
          continue;
        }
        if (
          !Number.isFinite(utime) ||
          !timestampInInclusiveWindow(utime, windowStartUnix, windowEndUnix)
        ) {
          continue;
        }
        includedHashes.add(hash);
        transfers.push(proved);
      }

      const nextFrom = body.next_from;
      const nextBeforeLt =
        typeof nextFrom === 'string' || typeof nextFrom === 'number' || typeof nextFrom === 'bigint'
          ? String(nextFrom)
          : null;
      if (nextBeforeLt === null || nextBeforeLt === '' || nextBeforeLt === '0') break;
      if (beforeLt !== undefined && nextBeforeLt === beforeLt) break;
      beforeLt = nextBeforeLt;

      const hasEvents = Array.isArray(body.events) && body.events.length > 0;
      const hasOperations = Array.isArray(body.operations) && body.operations.length > 0;
      if (!hasEvents && !hasOperations) break;
    }
  }

  /**
   * Prove a TEP-74 outgoing Jetton transfer from RAW transaction messages only.
   * High-level action/operation labels are never consulted here.
   */
  private async proveOutgoingJettonTransferFromRawTransaction(
    transaction: Record<string, unknown>,
    input: EnumerateOutgoingJettonTransfersInput,
    recipientWalletCache: Map<string, string | null>,
    warnings: string[],
    contextLabel = 'transaction',
  ): Promise<EnumeratedOutgoingJettonTransfer | null> {
    const account = optionalAddress(transaction.account);
    if (account === null || !addressEquals(account, input.hotWalletJettonWallet)) {
      return null;
    }
    if (!transactionSucceeded(transaction)) return null;

    const incoming =
      transaction.in_msg === undefined
        ? null
        : asRecord(transaction.in_msg, 'TonAPI jetton wallet in_msg');
    if (
      incoming === null ||
      incoming.msg_type !== 'int_msg' ||
      incoming.bounced === true ||
      optionalAddress(incoming.source) === null ||
      !addressEquals(optionalAddress(incoming.source)!, input.hotWalletAddress) ||
      optionalAddress(incoming.destination) === null ||
      !addressEquals(optionalAddress(incoming.destination)!, input.hotWalletJettonWallet)
    ) {
      return null;
    }

    const transferBody = messageBody(incoming);
    const transfer = transferBody === null ? null : parseJettonMessageHex(transferBody);
    if (
      transfer?.op !== JETTON_TRANSFER_OP ||
      transfer.address === undefined ||
      transfer.queryId === '' ||
      transfer.amountAtomic === ''
    ) {
      return null;
    }
    const recipient = transfer.address;
    if (addressEquals(recipient, input.hotWalletAddress)) return null;

    const matchingInternal = transactionMessages(transaction, 'out_msgs').find((message) => {
      if (message.msg_type !== 'int_msg' || message.bounced === true) return false;
      const body = messageBody(message);
      const internal = body === null ? null : parseJettonMessageHex(body);
      return (
        internal?.op === JETTON_INTERNAL_TRANSFER_OP &&
        internal.queryId === transfer.queryId &&
        internal.amountAtomic === transfer.amountAtomic &&
        internal.address !== undefined &&
        addressEquals(internal.address, input.hotWalletAddress)
      );
    });
    if (matchingInternal === undefined) return null;

    const recipientJettonWallet = optionalAddress(matchingInternal.destination);
    if (recipientJettonWallet === null) return null;

    const recipientKey = normalizeAddressKey(recipient);
    let resolvedRecipientWallet = recipientWalletCache.get(recipientKey);
    if (resolvedRecipientWallet === undefined) {
      try {
        resolvedRecipientWallet = await this.resolveJettonWallet(recipient, input.jettonMaster);
        recipientWalletCache.set(recipientKey, resolvedRecipientWallet);
      } catch (error) {
        warnings.push(
          `resolveJettonWallet(recipient) failed for ${contextLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        recipientWalletCache.set(recipientKey, null);
        // Fail closed: recipient jetton wallet binding is required.
        return null;
      }
    }
    if (
      resolvedRecipientWallet === null ||
      resolvedRecipientWallet === undefined ||
      !addressEquals(resolvedRecipientWallet, recipientJettonWallet)
    ) {
      warnings.push(`recipient jetton wallet mismatch for ${contextLabel}; skipped`);
      return null;
    }

    const transactionHash =
      typeof transaction.hash === 'string' && transaction.hash !== '' ? transaction.hash : null;
    const transactionLt =
      typeof transaction.lt === 'string' || typeof transaction.lt === 'number'
        ? String(transaction.lt)
        : null;
    const queryId = transfer.queryId === '0' ? null : transfer.queryId;
    const amountAtomic = transfer.amountAtomic;

    return {
      providerKind: 'tonapi',
      networkGlobalId: this.networkGlobalId,
      hotWalletAddress: input.hotWalletAddress,
      senderJettonWallet: input.hotWalletJettonWallet,
      jettonMaster: input.jettonMaster,
      transactionHash,
      transactionLt,
      queryId,
      amountAtomic,
      recipient,
      timestamp: unixSecondsToIso(Number(transaction.utime)),
      success: true,
      bounced: false,
      transferIdentity: buildTransferIdentity({
        queryId,
        transactionHash,
        transactionLt,
        amountAtomic,
        recipient,
      }),
    };
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
