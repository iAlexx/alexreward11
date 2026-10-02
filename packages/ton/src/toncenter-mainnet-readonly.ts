/**
 * Read-only Toncenter Mainnet client for Phase 21 ceremony probes.
 * Never exposes sendBoc / broadcast.
 * USDT metadata: indexed v3 jetton/masters (symbol+decimals) + get_jetton_data reachability.
 */
import { Address, beginCell, Cell } from '@ton/core';

import { toCanonicalFriendlyAddress, tonAddressesEqual } from './address.js';
import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import {
  asRecord,
  assertMainnetProviderUrl,
  mainnetFetchJson,
  normalizeMainnetProviderHost,
  redactProviderErrorMessage,
  resolveExpectedMainnetGlobalId,
  type MainnetProviderVerificationClass,
} from './mainnet-provider-http.js';
import { parseStackNumber } from './provider-http.js';
import { deriveTonCenterV3BaseUrl } from './toncenter-testnet-provider.js';

export interface ToncenterMainnetReadonlyConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Required to claim -239 when response body cannot prove it. */
  readonly expectedNetworkGlobalId?: number | null;
}

export interface ToncenterJettonMetadataResult {
  readonly ok: boolean;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly observedJettonMaster: string | null;
  readonly metadataSource: string | null;
  readonly message: string;
  readonly providerHost: string;
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

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function readDecimals(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Parse symbol + decimals from Toncenter v3 indexed jetton/masters payload.
 * Sources (first wins, no invention): token_info[], jetton_content, extra.
 */
export function parseToncenterV3JettonIndexedMetadata(body: unknown): {
  symbol: string | null;
  decimals: number | null;
  observedAddress: string | null;
  metadataSource: string | null;
} {
  if (body === null || typeof body !== 'object') {
    return { symbol: null, decimals: null, observedAddress: null, metadataSource: null };
  }
  const root = body as Record<string, unknown>;
  const masters = Array.isArray(root.jetton_masters) ? root.jetton_masters : [];
  const firstMaster =
    masters.length > 0 && masters[0] !== null && typeof masters[0] === 'object'
      ? (masters[0] as Record<string, unknown>)
      : null;
  const observedAddress =
    firstMaster !== null ? readStringField(firstMaster, 'address') : null;

  let symbol: string | null = null;
  let decimals: number | null = null;
  let metadataSource: string | null = null;

  const metadataRoot =
    root.metadata !== null && typeof root.metadata === 'object' && !Array.isArray(root.metadata)
      ? (root.metadata as Record<string, unknown>)
      : null;

  const metaKeys: string[] = [];
  if (observedAddress !== null) metaKeys.push(observedAddress);
  if (metadataRoot !== null) {
    for (const key of Object.keys(metadataRoot)) {
      if (!metaKeys.includes(key)) metaKeys.push(key);
    }
  }

  for (const key of metaKeys) {
    if (metadataRoot === null) break;
    const entry = metadataRoot[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entryRec = entry as Record<string, unknown>;
    const tokenInfo = Array.isArray(entryRec.token_info) ? entryRec.token_info : [];
    for (const info of tokenInfo) {
      if (info === null || typeof info !== 'object' || Array.isArray(info)) continue;
      const infoRec = info as Record<string, unknown>;
      if (infoRec.valid === false) continue;
      const sym = readStringField(infoRec, 'symbol');
      const extra =
        infoRec.extra !== null && typeof infoRec.extra === 'object' && !Array.isArray(infoRec.extra)
          ? (infoRec.extra as Record<string, unknown>)
          : null;
      const dec =
        readDecimals(infoRec.decimals) ??
        (extra !== null ? readDecimals(extra.decimals) : null);
      if (sym !== null && dec !== null) {
        return {
          symbol: sym,
          decimals: dec,
          observedAddress,
          metadataSource: 'toncenter_v3_metadata.token_info',
        };
      }
      if (symbol === null && sym !== null) {
        symbol = sym;
        metadataSource = 'toncenter_v3_metadata.token_info.partial';
      }
      if (decimals === null && dec !== null) {
        decimals = dec;
        metadataSource = metadataSource ?? 'toncenter_v3_metadata.token_info.partial';
      }
    }
  }

  if (firstMaster !== null) {
    const content = firstMaster.jetton_content;
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      const contentRec = content as Record<string, unknown>;
      const sym = readStringField(contentRec, 'symbol');
      const dec = readDecimals(contentRec.decimals);
      if (symbol === null && sym !== null) {
        symbol = sym;
        metadataSource = 'toncenter_v3_jetton_content';
      }
      if (decimals === null && dec !== null) {
        decimals = dec;
        metadataSource = metadataSource ?? 'toncenter_v3_jetton_content';
      }
      const extra =
        contentRec.extra !== null &&
        typeof contentRec.extra === 'object' &&
        !Array.isArray(contentRec.extra)
          ? (contentRec.extra as Record<string, unknown>)
          : null;
      if (decimals === null && extra !== null) {
        const extraDec = readDecimals(extra.decimals);
        if (extraDec !== null) {
          decimals = extraDec;
          metadataSource = metadataSource ?? 'toncenter_v3_jetton_content.extra';
        }
      }
    }
  }

  if (symbol !== null && decimals !== null && metadataSource === null) {
    metadataSource = 'toncenter_v3_indexed';
  }
  if (symbol === null || decimals === null) {
    return { symbol, decimals, observedAddress, metadataSource: null };
  }
  return { symbol, decimals, observedAddress, metadataSource };
}

export class ToncenterMainnetReadonlyClient {
  readonly baseUrl: string;
  readonly v3BaseUrl: string;
  readonly providerHost: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly expectedNetworkGlobalId: number | null;

  constructor(config: ToncenterMainnetReadonlyConfig) {
    this.baseUrl = assertMainnetProviderUrl(config.baseUrl, 'ToncenterMainnet');
    this.v3BaseUrl = deriveTonCenterV3BaseUrl(this.baseUrl);
    this.providerHost = normalizeMainnetProviderHost(this.baseUrl);
    this.apiKey = config.apiKey?.trim() || null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.expectedNetworkGlobalId = resolveExpectedMainnetGlobalId(
      config.expectedNetworkGlobalId ?? TON_MAINNET_NETWORK_GLOBAL_ID,
    );
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
    if (this.apiKey !== null) headers['X-API-Key'] = this.apiKey;
    return headers;
  }

  private async get(method: string, context: string): Promise<unknown> {
    const url = `${this.baseUrl}/${method}`;
    const body = await mainnetFetchJson(
      this.fetchImpl,
      url,
      { method: 'GET', headers: this.headers() },
      context,
      this.baseUrl,
    );
    assertOkTonCenterMainnetBody(body, context);
    return body.result;
  }

  private async getV3(pathWithQuery: string, context: string): Promise<unknown> {
    const url = `${this.v3BaseUrl}${pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`}`;
    return mainnetFetchJson(
      this.fetchImpl,
      url,
      { method: 'GET', headers: this.headers() },
      context,
      this.baseUrl,
    );
  }

  private async post(
    method: string,
    payload: Record<string, unknown>,
    context: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/${method}`;
    const body = await mainnetFetchJson(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: this.headers(true),
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
   * Probe Mainnet identity.
   * Verification class: VERIFIED_PROVIDER_MAINNET_ENDPOINT =
   *   url allowlist + getMasterchainInfo health + expectedNetworkGlobalId=-239
   * (getMasterchainInfo does not return -239 in body).
   */
  async probeNetworkIdentity(): Promise<{
    ok: boolean;
    networkGlobalId: number | null;
    message: string;
    providerHost: string;
    verificationMethod: string;
    verificationClass: MainnetProviderVerificationClass;
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
          verificationClass: 'INCOMPLETE',
        };
      }
      return {
        ok: true,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        message:
          'Toncenter Mainnet identity accepted via allowlisted URL + getMasterchainInfo health + expectedNetworkGlobalId=-239',
        providerHost: this.providerHost,
        verificationMethod: 'toncenter_url+getMasterchainInfo+expectedNetworkGlobalId',
        verificationClass: 'VERIFIED_PROVIDER_MAINNET_ENDPOINT',
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
        verificationClass: 'INCOMPLETE',
      };
    }
  }

  /**
   * Indexed metadata via v3 GET /api/v3/jetton/masters?address=...
   * get_jetton_data is a reachability check only — not sufficient alone for ok=true.
   */
  async getJettonMetadata(jettonMaster: string): Promise<ToncenterJettonMetadataResult> {
    const requestedCanonical = toCanonicalFriendlyAddress(jettonMaster);
    const fallbackObserved = requestedCanonical;

    try {
      // Reachability (not authoritative for symbol/decimals).
      let reachable = false;
      try {
        const stack = await this.runGetMethod(jettonMaster, 'get_jetton_data', []);
        if (stack.length >= 4) {
          void parseStackNumber(stack[0], 'total_supply');
          void stackCellBase64(stack[3], 'jetton content');
          reachable = true;
        }
      } catch {
        reachable = false;
      }

      const v3Body = await this.getV3(
        `/jetton/masters?address=${encodeURIComponent(jettonMaster)}`,
        'ToncenterMainnet v3 jetton/masters',
      );
      const parsed = parseToncenterV3JettonIndexedMetadata(v3Body);

      let observedJettonMaster: string | null = null;
      if (parsed.observedAddress !== null) {
        observedJettonMaster =
          toCanonicalFriendlyAddress(parsed.observedAddress) ?? parsed.observedAddress;
        if (
          requestedCanonical !== null &&
          !tonAddressesEqual(requestedCanonical, observedJettonMaster)
        ) {
          return {
            ok: false,
            symbol: parsed.symbol,
            decimals: parsed.decimals,
            observedJettonMaster,
            metadataSource: parsed.metadataSource,
            message: 'Toncenter v3 observed jetton master does not match requested master',
            providerHost: this.providerHost,
          };
        }
      } else {
        observedJettonMaster = fallbackObserved;
      }

      if (parsed.symbol === null || parsed.decimals === null || parsed.metadataSource === null) {
        return {
          ok: false,
          symbol: parsed.symbol,
          decimals: parsed.decimals,
          observedJettonMaster,
          metadataSource: parsed.metadataSource,
          message: reachable
            ? 'Toncenter get_jetton_data reachable but indexed v3 metadata missing symbol/decimals'
            : 'Toncenter indexed v3 metadata missing symbol/decimals (get_jetton_data also incomplete)',
          providerHost: this.providerHost,
        };
      }

      if (!reachable) {
        return {
          ok: false,
          symbol: parsed.symbol,
          decimals: parsed.decimals,
          observedJettonMaster,
          metadataSource: parsed.metadataSource,
          message:
            'Toncenter indexed metadata present but get_jetton_data reachability check failed',
          providerHost: this.providerHost,
        };
      }

      return {
        ok: true,
        symbol: parsed.symbol,
        decimals: parsed.decimals,
        observedJettonMaster,
        metadataSource: parsed.metadataSource,
        message: 'Toncenter indexed jetton metadata ok (v3 + get_jetton_data reachability)',
        providerHost: this.providerHost,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        symbol: null,
        decimals: null,
        observedJettonMaster: fallbackObserved,
        metadataSource: null,
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
   * Read-only estimateFee. Never broadcasts.
   * Pass bodyBase64 of unsigned Jetton transfer for realistic estimation.
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
