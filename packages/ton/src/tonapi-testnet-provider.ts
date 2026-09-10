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
    const body = await this.get(
      `/v2/accounts/${encodeURIComponent(address)}`,
      'TonAPI account',
    );
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
    const body = await this.get(
      `/v2/accounts/${encodeURIComponent(input.hotWallet)}/events?limit=50`,
      'TonAPI account events',
    );
    if (!Array.isArray(body.events)) {
      throw new Error('MALFORMED_RESPONSE: TonAPI events array missing');
    }

    const evidence: JettonTransferEvidence[] = [];
    for (const rawEvent of body.events) {
      const event = asRecord(rawEvent, 'TonAPI event');
      if (!Array.isArray(event.actions)) continue;
      for (const rawAction of event.actions) {
        const action = asRecord(rawAction, 'TonAPI action');
        if (action.type !== 'JettonTransfer') continue;
        const transfer = asRecord(action.JettonTransfer, 'TonAPI JettonTransfer');
        const queryId = decimalString(transfer.query_id, 'TonAPI JettonTransfer query_id');
        const amountAtomic = decimalString(transfer.amount, 'TonAPI JettonTransfer amount');
        const recipient = addressValue(transfer.recipient, 'TonAPI JettonTransfer recipient');
        const jettonMaster = addressValue(transfer.jetton, 'TonAPI JettonTransfer jetton');
        const sender = addressValue(transfer.sender, 'TonAPI JettonTransfer sender');
        const senderWallet = addressValue(
          transfer.senders_wallet,
          'TonAPI JettonTransfer senders_wallet',
        );
        addressValue(transfer.recipients_wallet, 'TonAPI JettonTransfer recipients_wallet');
        if (
          queryId !== input.queryId ||
          !addressEquals(jettonMaster, input.jettonMaster) ||
          !addressEquals(sender, input.hotWallet) ||
          (input.recipient !== undefined && !addressEquals(recipient, input.recipient))
        ) {
          continue;
        }
        const succeeded = action.status === 'ok';
        evidence.push({
          hotWallet: input.hotWallet,
          jettonMaster: input.jettonMaster,
          recipient,
          amountAtomic,
          queryId,
          success: succeeded,
          bounced: !succeeded,
          ...(typeof event.event_id === 'string' ? { transactionHash: event.event_id } : {}),
          ...(typeof event.lt === 'string' ? { lt: event.lt } : {}),
          networkGlobalId: this.networkGlobalId,
          senderJettonWallet: senderWallet,
          providerKind: 'tonapi',
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
