/**
 * Read-only TonAPI Mainnet client for Phase 21 ceremony probes.
 * Never exposes sendBoc / broadcast.
 */
import { toCanonicalFriendlyAddress } from './address.js';
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
        message: redactProviderErrorMessage(
          error instanceof Error ? error.message : String(error),
          this.baseUrl,
        ),
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
      const body = await this.get(
        `/v2/accounts/${encodeURIComponent(ownerAddress)}/jettons/${encodeURIComponent(jettonMaster)}`,
        'TonapiMainnet jetton wallet',
      );
      const record = asRecord(body, 'TonapiMainnet account jetton');
      const wallet =
        record.wallet_address !== null &&
        typeof record.wallet_address === 'object' &&
        !Array.isArray(record.wallet_address)
          ? (record.wallet_address as Record<string, unknown>).address
          : record.wallet_address;
      if (typeof wallet !== 'string' || wallet.trim() === '') {
        return {
          ok: false,
          jettonWalletAddress: null,
          message: 'TonAPI jetton wallet address missing',
          providerHost: this.providerHost,
        };
      }
      return {
        ok: true,
        jettonWalletAddress: wallet,
        message: 'TonAPI jetton wallet derived',
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
}
