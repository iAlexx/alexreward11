/**
 * Read-only TonAPI Mainnet client for Phase 21 ceremony probes.
 * Never exposes sendBoc / broadcast.
 */
import { Cell } from '@ton/core';

import { canonicalizeTonAddress, toCanonicalFriendlyAddress } from './address.js';
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

export interface TonapiMainnetReadonlyConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly expectedNetworkGlobalId?: number | null;
}

export interface TonapiJettonMetadataResult {
  readonly ok: boolean;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly observedJettonMaster: string | null;
  readonly metadataSource: string | null;
  readonly message: string;
  readonly providerHost: string;
}

export class TonapiMainnetReadonlyClient {
  readonly baseUrl: string;
  readonly providerHost: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly expectedNetworkGlobalId: number | null;

  constructor(config: TonapiMainnetReadonlyConfig) {
    this.baseUrl = assertMainnetProviderUrl(config.baseUrl, 'TonapiMainnet');
    this.providerHost = normalizeMainnetProviderHost(this.baseUrl);
    this.apiKey = config.apiKey?.trim() || null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.expectedNetworkGlobalId = resolveExpectedMainnetGlobalId(
      config.expectedNetworkGlobalId ?? TON_MAINNET_NETWORK_GLOBAL_ID,
    );
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey !== null) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async get(path: string, context: string): Promise<unknown> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    return mainnetFetchJson(
      this.fetchImpl,
      url,
      { method: 'GET', headers: this.headers() },
      context,
      this.baseUrl,
    );
  }

  /** Redact provider URL material and configured Bearer API key from error surfaces. */
  private redactError(message: string): string {
    let out = redactProviderErrorMessage(message, this.baseUrl);
    if (this.apiKey !== null && this.apiKey !== '') {
      out = out.split(this.apiKey).join('[REDACTED]');
    }
    out = out.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    out = out.replace(/([?&](api_key|apikey|api-key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
    return out;
  }

  /**
   * Probe Mainnet identity via /v2/status and optional /v2/blockchain/config.
   * PROVEN_FROM_CHAIN_RESPONSE when body proves -239; otherwise
   * VERIFIED_PROVIDER_MAINNET_ENDPOINT when allowlisted URL + status + expected=-239.
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
      const statusBody = await this.get('/v2/status', 'TonapiMainnet status');
      const status = asRecord(statusBody, 'TonapiMainnet status');
      if (status.rest_online !== true) {
        return {
          ok: false,
          networkGlobalId: null,
          message: 'TonAPI REST API is offline',
          providerHost: this.providerHost,
          verificationMethod: 'tonapi_status_offline',
          verificationClass: 'INCOMPLETE',
        };
      }

      let provenFromBody: number | null = null;
      try {
        const configBody = await this.get('/v2/blockchain/config', 'TonapiMainnet blockchain config');
        const cfg = asRecord(configBody, 'TonapiMainnet blockchain config');
        const candidates = [
          cfg.global_id,
          cfg.network_global_id,
          cfg.networkGlobalId,
          asRecord(cfg.raw ?? {}, 'raw').global_id,
        ];
        for (const c of candidates) {
          if (c === TON_MAINNET_NETWORK_GLOBAL_ID || c === '-239' || c === -239) {
            provenFromBody = TON_MAINNET_NETWORK_GLOBAL_ID;
            break;
          }
          if (c === -3 || c === '-3') {
            return {
              ok: false,
              networkGlobalId: -3,
              message: 'TonAPI blockchain config indicates Testnet (-3)',
              providerHost: this.providerHost,
              verificationMethod: 'tonapi_blockchain_config',
              verificationClass: 'INCOMPLETE',
            };
          }
        }
      } catch {
        // config endpoint optional
      }

      if (provenFromBody === TON_MAINNET_NETWORK_GLOBAL_ID) {
        return {
          ok: true,
          networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
          message: 'TonAPI Mainnet identity proven from blockchain config (-239)',
          providerHost: this.providerHost,
          verificationMethod: 'tonapi_blockchain_config',
          verificationClass: 'PROVEN_FROM_CHAIN_RESPONSE',
        };
      }

      if (this.expectedNetworkGlobalId !== TON_MAINNET_NETWORK_GLOBAL_ID) {
        return {
          ok: false,
          networkGlobalId: null,
          message:
            'TonAPI status healthy but -239 not proven from body and expectedNetworkGlobalId=-239 not configured',
          providerHost: this.providerHost,
          verificationMethod: 'tonapi_status_incomplete',
          verificationClass: 'INCOMPLETE',
        };
      }

      return {
        ok: true,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        message:
          'TonAPI Mainnet identity accepted via allowlisted URL + /v2/status health + expectedNetworkGlobalId=-239',
        providerHost: this.providerHost,
        verificationMethod: 'tonapi_url+status+expectedNetworkGlobalId',
        verificationClass: 'VERIFIED_PROVIDER_MAINNET_ENDPOINT',
      };
    } catch (error: unknown) {
      return {
        ok: false,
        networkGlobalId: null,
        message: this.redactError(error instanceof Error ? error.message : String(error)),
        providerHost: this.providerHost,
        verificationMethod: 'tonapi_status_failed',
        verificationClass: 'INCOMPLETE',
      };
    }
  }

  async getJettonMetadata(jettonMaster: string): Promise<TonapiJettonMetadataResult> {
    const requestedCanonical = toCanonicalFriendlyAddress(jettonMaster);
    try {
      const body = await this.get(
        `/v2/jettons/${encodeURIComponent(jettonMaster)}`,
        'TonapiMainnet jetton metadata',
      );
      const record = asRecord(body, 'TonapiMainnet jetton');
      const meta =
        record.metadata !== null && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : record;
      const symbol = typeof meta.symbol === 'string' ? meta.symbol.trim() : null;
      let decimals: number | null = null;
      if (typeof meta.decimals === 'number' && Number.isFinite(meta.decimals)) {
        decimals = meta.decimals;
      } else if (typeof meta.decimals === 'string' && /^\d+$/.test(meta.decimals)) {
        decimals = Number(meta.decimals);
      }

      const responseAddress =
        typeof record.address === 'string'
          ? record.address
          : typeof meta.address === 'string'
            ? meta.address
            : null;
      const observedJettonMaster =
        (responseAddress !== null
          ? toCanonicalFriendlyAddress(responseAddress)
          : null) ?? requestedCanonical;

      if (symbol === null || decimals === null) {
        return {
          ok: false,
          symbol,
          decimals,
          observedJettonMaster,
          metadataSource: null,
          message: 'TonAPI jetton metadata missing symbol/decimals',
          providerHost: this.providerHost,
        };
      }
      return {
        ok: true,
        symbol,
        decimals,
        observedJettonMaster,
        metadataSource: 'tonapi_v2_jettons.metadata',
        message: 'TonAPI jetton metadata ok',
        providerHost: this.providerHost,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        symbol: null,
        decimals: null,
        observedJettonMaster: requestedCanonical,
        metadataSource: null,
        message: this.redactError(error instanceof Error ? error.message : String(error)),
        providerHost: this.providerHost,
      };
    }
  }

  /**
   * Deterministic Jetton wallet derivation via jetton-master get-method
   * `get_wallet_address` (TonAPI execGetMethodForBlockchainAccount).
   *
   * Does NOT use indexed account balance lookup
   * `/v2/accounts/{owner}/jettons/{master}` — that 404s for never-deployed wallets.
   * Read-only: no send / broadcast / emulation mutation.
   */
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
      const master = canonicalizeTonAddress(jettonMaster);
      const owner = canonicalizeTonAddress(ownerAddress);
      const params = new URLSearchParams();
      // TonAPI accepts TON addresses as get-method args (raw 0:hex form).
      params.append('args', owner.rawAddress);
      const path =
        `/v2/blockchain/accounts/${encodeURIComponent(master.rawAddress)}` +
        `/methods/get_wallet_address?${params.toString()}`;
      const body = await this.get(path, 'TonapiMainnet get_wallet_address');
      const record = asRecord(body, 'TonapiMainnet get_wallet_address');

      if (record.success !== true) {
        return {
          ok: false,
          jettonWalletAddress: null,
          message: 'TonAPI get_wallet_address execution reported success=false',
          providerHost: this.providerHost,
        };
      }
      if (record.exit_code !== 0 && record.exit_code !== '0') {
        return {
          ok: false,
          jettonWalletAddress: null,
          message: `TonAPI get_wallet_address failed exit_code=${String(record.exit_code ?? 'missing')}`,
          providerHost: this.providerHost,
        };
      }

      const decodedAddress = extractTonapiDecodedJettonWalletAddress(record.decoded);
      const stackAddress =
        decodedAddress === null ? extractTonapiStackJettonWalletAddress(record.stack) : null;
      const wallet = decodedAddress ?? stackAddress;
      if (wallet === null || wallet.trim() === '') {
        return {
          ok: false,
          jettonWalletAddress: null,
          message: 'TonAPI get_wallet_address missing decoded/stack jetton wallet address',
          providerHost: this.providerHost,
        };
      }

      const canonicalWallet = toCanonicalFriendlyAddress(wallet);
      if (canonicalWallet === null) {
        return {
          ok: false,
          jettonWalletAddress: null,
          message: 'TonAPI get_wallet_address returned unparseable jetton wallet address',
          providerHost: this.providerHost,
        };
      }

      return {
        ok: true,
        jettonWalletAddress: canonicalWallet,
        message: 'TonAPI get_wallet_address derived',
        providerHost: this.providerHost,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        jettonWalletAddress: null,
        message: this.redactError(error instanceof Error ? error.message : String(error)),
        providerHost: this.providerHost,
      };
    }
  }
}

/** Prefer TonAPI decoded fields; never invent addresses. */
export function extractTonapiDecodedJettonWalletAddress(decoded: unknown): string | null {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  const candidates = [record.jetton_wallet_address, record.jettonWalletAddress];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      typeof (candidate as Record<string, unknown>).address === 'string'
    ) {
      const nested = String((candidate as Record<string, unknown>).address).trim();
      if (nested !== '') return nested;
    }
  }
  return null;
}

/**
 * Strict fallback for TonAPI MethodExecutionResult.stack when decoded is absent.
 * Supports cell/slice BOC forms only; fails closed otherwise.
 */
export function extractTonapiStackJettonWalletAddress(stack: unknown): string | null {
  if (!Array.isArray(stack) || stack.length === 0) return null;
  const first = stack[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
  const entry = first as Record<string, unknown>;
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  const bocCandidate =
    (typeof entry.cell === 'string' ? entry.cell : null) ??
    (typeof entry.slice === 'string' ? entry.slice : null) ??
    (typeof entry.bytes === 'string' ? entry.bytes : null) ??
    (typeof entry.value === 'string' ? entry.value : null);
  if (bocCandidate === null || bocCandidate.trim() === '') return null;
  if (type !== '' && type !== 'cell' && type !== 'slice') return null;
  try {
    const cell = Cell.fromBase64(bocCandidate.trim());
    const address = cell.beginParse().loadAddress();
    if (address === null) return null;
    return address.toString({ urlSafe: true, bounceable: true });
  } catch {
    return null;
  }
}
