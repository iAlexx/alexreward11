/**
 * Read-only Toncenter Mainnet client for Phase 21 ceremony probes.
 * Never exposes sendBoc / broadcast.
 */
import { Address, beginCell, Cell } from '@ton/core';

import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import {
  asRecord,
  assertMainnetProviderUrl,
  appendApiKey,
  mainnetFetchJson,
  normalizeMainnetProviderHost,
  redactProviderErrorMessage,
  resolveExpectedMainnetGlobalId,
} from './mainnet-provider-http.js';
import { parseStackNumber } from './provider-http.js';

export interface ToncenterMainnetReadonlyConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Required to claim -239 when response body cannot prove it. */
  readonly expectedNetworkGlobalId?: number | null;
}

type StackEntry = readonly [unknown, unknown];

function stackFromResult(result: unknown, context: string): StackEntry[] {
  const record = asRecord(result, context);
  const exitCode = Number(record.exit_code);
  if (exitCode !== 0) {
    throw new Error(`TONCENTER_GET_METHOD_FAILED: ${context} exit_code=${exitCode}`);
  }
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
  const roots = Cell.fromBase64(base64);
  const address = roots.beginParse().loadAddress();
  if (address === null) throw new Error(`MALFORMED_RESPONSE: ${context} null address`);
  return address.toString();
}

function assertOkTonCenterMainnetBody(
  body: unknown,
  context: string,
): asserts body is { ok: true; result: unknown } {
  if (body === null || typeof body !== 'object') {
    throw new Error(`MALFORMED_RESPONSE: ${context} did not return an object`);
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true || !('result' in record)) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.description === 'string'
          ? record.description
          : 'ok/result missing';
    throw new Error(`TONCENTER_ERROR: ${context}: ${message}`);
  }
}

export class ToncenterMainnetReadonlyClient {
  readonly baseUrl: string;
  readonly providerHost: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly expectedNetworkGlobalId: number | null;

  constructor(config: ToncenterMainnetReadonlyConfig) {
    this.baseUrl = assertMainnetProviderUrl(config.baseUrl, 'ToncenterMainnet');
    this.providerHost = normalizeMainnetProviderHost(this.baseUrl);
    this.apiKey = config.apiKey?.trim() || null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.expectedNetworkGlobalId = resolveExpectedMainnetGlobalId(
      config.expectedNetworkGlobalId ?? TON_MAINNET_NETWORK_GLOBAL_ID,
    );
  }

  private async get(method: string, context: string): Promise<unknown> {
    const url = appendApiKey(`${this.baseUrl}/${method}`, this.apiKey);
    const body = await mainnetFetchJson(
      this.fetchImpl,
      url,
      { method: 'GET' },
      context,
      this.baseUrl,
    );
    assertOkTonCenterMainnetBody(body, context);
    return body.result;
  }

  private async post(
    method: string,
    payload: Record<string, unknown>,
    context: string,
  ): Promise<unknown> {
    const url = appendApiKey(`${this.baseUrl}/${method}`, this.apiKey);
    const body = await mainnetFetchJson(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      context,
      this.baseUrl,
    );
    assertOkTonCenterMainnetBody(body, context);
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
      `ToncenterMainnet runGetMethod ${method}`,
    );
    return stackFromResult(result, `ToncenterMainnet ${method}`);
  }

  /**
   * Probe Mainnet identity. getMasterchainInfo does not return -239 in body;
   * PASS requires healthy response + mainnet URL assert + expectedNetworkGlobalId=-239.
   */
  async probeNetworkIdentity(): Promise<{
    ok: boolean;
    networkGlobalId: number | null;
    message: string;
    providerHost: string;
    verificationMethod: string;
  }> {
    try {
      const result = await this.get('getMasterchainInfo', 'ToncenterMainnet getMasterchainInfo');
      asRecord(result, 'ToncenterMainnet masterchain info');
      if (this.expectedNetworkGlobalId !== TON_MAINNET_NETWORK_GLOBAL_ID) {
        return {
          ok: false,
          networkGlobalId: null,
          message:
            'Toncenter getMasterchainInfo healthy but expectedNetworkGlobalId=-239 not configured; refusing hostname-only PASS',
          providerHost: this.providerHost,
          verificationMethod: 'toncenter_getMasterchainInfo_incomplete',
        };
      }
      return {
        ok: true,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        message:
          'Toncenter Mainnet identity accepted via mainnet URL assert + getMasterchainInfo health + expectedNetworkGlobalId=-239',
        providerHost: this.providerHost,
        verificationMethod: 'toncenter_url+getMasterchainInfo+expectedNetworkGlobalId',
      };
    } catch (error: unknown) {
      return {
        ok: false,
        networkGlobalId: null,
        message: redactProviderErrorMessage(
          error instanceof Error ? error.message : String(error),
          this.baseUrl,
        ),
        providerHost: this.providerHost,
        verificationMethod: 'toncenter_getMasterchainInfo_failed',
      };
    }
  }

  async getJettonMetadata(jettonMaster: string): Promise<{
    ok: boolean;
    symbol: string | null;
    decimals: number | null;
    message: string;
    providerHost: string;
  }> {
    try {
      const stack = await this.runGetMethod(jettonMaster, 'get_jetton_data', []);
      if (stack.length < 4) {
        return {
          ok: false,
          symbol: null,
          decimals: null,
          message: 'get_jetton_data stack incomplete',
          providerHost: this.providerHost,
        };
      }
      void parseStackNumber(stack[0], 'total_supply');
      void stackCellBase64(stack[3], 'jetton content');
      return {
        ok: false,
        symbol: null,
        decimals: null,
        message:
          'Toncenter get_jetton_data reachable but on-chain content is not treated as authoritative for symbol/decimals (use TonAPI or dual-provider)',
        providerHost: this.providerHost,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        symbol: null,
        decimals: null,
        message: redactProviderErrorMessage(
          error instanceof Error ? error.message : String(error),
          this.baseUrl,
        ),
        providerHost: this.providerHost,
      };
    }
  }

  async getJettonWalletAddress(
    jettonMaster: string,
    ownerAddress: string,
  ): Promise<{
    ok: boolean;
    jettonWalletAddress: string | null;
    message: string;
    providerHost: string;
  }> {
    try {
      const ownerCell = beginCell()
        .storeAddress(Address.parse(ownerAddress))
        .endCell()
        .toBoc()
        .toString('base64');
      const walletStack = await this.runGetMethod(jettonMaster, 'get_wallet_address', [
        ['tvm.Slice', ownerCell],
      ]);
      const address = parseAddressCell(
        stackCellBase64(walletStack[0], 'get_wallet_address'),
        'get_wallet_address',
      );
      return {
        ok: true,
        jettonWalletAddress: address,
        message: 'Toncenter get_wallet_address derived',
        providerHost: this.providerHost,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        jettonWalletAddress: null,
        message: redactProviderErrorMessage(
          error instanceof Error ? error.message : String(error),
          this.baseUrl,
        ),
        providerHost: this.providerHost,
      };
    }
  }

  /**
   * Read-only estimatefee if provider supports it. Never broadcasts.
   */
  async estimateFeeNanotons(input: {
    readonly address: string;
    readonly bodyBase64?: string;
  }): Promise<{
    ok: boolean;
    feeNanotons: bigint | null;
    message: string;
    estimateMethod: string;
  }> {
    try {
      const result = await this.post(
        'estimateFee',
        {
          address: input.address,
          body: input.bodyBase64 ?? '',
          init_code: '',
          init_data: '',
          ignore_chksig: true,
        },
        'ToncenterMainnet estimateFee',
      );
      const record = asRecord(result, 'estimateFee result');
      const sourceFees = record.source_fees;
      if (sourceFees === null || typeof sourceFees !== 'object' || Array.isArray(sourceFees)) {
        return {
          ok: false,
          feeNanotons: null,
          message: 'estimateFee response missing source_fees',
          estimateMethod: 'estimateFee',
        };
      }
      const fees = sourceFees as Record<string, unknown>;
      const parts = ['in_fwd_fee', 'storage_fee', 'gas_fee', 'fwd_fee'] as const;
      let total = 0n;
      for (const key of parts) {
        const raw = fees[key];
        if (raw === undefined || raw === null) continue;
        total += BigInt(String(raw));
      }
      if (total <= 0n) {
        return {
          ok: false,
          feeNanotons: null,
          message: 'estimateFee returned non-positive total; treating as UNAVAILABLE',
          estimateMethod: 'estimateFee',
        };
      }
      return {
        ok: true,
        feeNanotons: total,
        message: 'Toncenter estimateFee read-only',
        estimateMethod: 'estimateFee',
      };
    } catch (error: unknown) {
      return {
        ok: false,
        feeNanotons: null,
        message: redactProviderErrorMessage(
          error instanceof Error ? error.message : String(error),
          this.baseUrl,
        ),
        estimateMethod: 'estimateFee_unavailable',
      };
    }
  }
}
