/**
 * Phase 21 concrete Mainnet external adapter factory.
 * Wraps Toncenter/TonAPI read-only clients for probe interfaces.
 * Never broadcasts / never sendBoc.
 */
import {
  TonapiMainnetReadonlyClient,
  ToncenterMainnetReadonlyClient,
  TON_MAINNET_NETWORK_GLOBAL_ID,
} from '@alex-rewards/ton';

import type {
  JettonWalletDerivationProbeAdapter,
  MainnetIdentityProbeAdapter,
  UsdtJettonMetadataProbeAdapter,
} from './phase21-external-probes.js';

export type Phase21MainnetProviderKind = 'toncenter' | 'tonapi';

export interface Phase21MainnetProviderEndpoint {
  readonly kind: Phase21MainnetProviderKind;
  readonly url: string;
  readonly apiKey?: string | null;
}

export interface Phase21MainnetExternalAdaptersConfig {
  readonly primary: Phase21MainnetProviderEndpoint;
  readonly secondary: Phase21MainnetProviderEndpoint;
  readonly expectedNetworkGlobalId?: number | null;
  readonly fetchImpl?: typeof fetch;
}

function createClient(
  endpoint: Phase21MainnetProviderEndpoint,
  expectedNetworkGlobalId: number,
  fetchImpl?: typeof fetch,
): ToncenterMainnetReadonlyClient | TonapiMainnetReadonlyClient {
  const shared = {
    baseUrl: endpoint.url,
    apiKey: endpoint.apiKey ?? null,
    expectedNetworkGlobalId,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };
  if (endpoint.kind === 'toncenter') {
    return new ToncenterMainnetReadonlyClient(shared);
  }
  return new TonapiMainnetReadonlyClient(shared);
}

function clientForKind(
  clients: {
    readonly toncenter?: ToncenterMainnetReadonlyClient;
    readonly tonapi?: TonapiMainnetReadonlyClient;
  },
  kind: string,
): ToncenterMainnetReadonlyClient | TonapiMainnetReadonlyClient {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'toncenter' && clients.toncenter !== undefined) return clients.toncenter;
  if (normalized === 'tonapi' && clients.tonapi !== undefined) return clients.tonapi;
  throw new Error(`No Mainnet client configured for provider kind=${kind}`);
}

/**
 * Build identity/metadata/derivation adapters backed by concrete Mainnet HTTP clients.
 * Primary and secondary may be toncenter+tonapi (independent kinds).
 */
export function createPhase21MainnetExternalAdapters(config: Phase21MainnetExternalAdaptersConfig): {
  readonly identity: MainnetIdentityProbeAdapter;
  readonly metadata: UsdtJettonMetadataProbeAdapter;
  readonly derivation: JettonWalletDerivationProbeAdapter;
  readonly clients: {
    readonly primary: ToncenterMainnetReadonlyClient | TonapiMainnetReadonlyClient;
    readonly secondary: ToncenterMainnetReadonlyClient | TonapiMainnetReadonlyClient;
  };
} {
  const expected =
    config.expectedNetworkGlobalId === undefined || config.expectedNetworkGlobalId === null
      ? TON_MAINNET_NETWORK_GLOBAL_ID
      : config.expectedNetworkGlobalId;

  const primary = createClient(config.primary, expected, config.fetchImpl);
  const secondary = createClient(config.secondary, expected, config.fetchImpl);

  const byKind: {
    toncenter?: ToncenterMainnetReadonlyClient;
    tonapi?: TonapiMainnetReadonlyClient;
  } = {};
  if (config.primary.kind === 'toncenter') {
    byKind.toncenter = primary as ToncenterMainnetReadonlyClient;
  } else {
    byKind.tonapi = primary as TonapiMainnetReadonlyClient;
  }
  if (config.secondary.kind === 'toncenter') {
    byKind.toncenter = secondary as ToncenterMainnetReadonlyClient;
  } else {
    byKind.tonapi = secondary as TonapiMainnetReadonlyClient;
  }

  const identity: MainnetIdentityProbeAdapter = {
    async probe(input) {
      const client = clientForKind(byKind, input.providerKind);
      const result = await client.probeNetworkIdentity();
      return {
        ok: result.ok,
        networkGlobalId: result.networkGlobalId,
        message: result.message,
        providerHost: result.providerHost,
      };
    },
  };

  const metadata: UsdtJettonMetadataProbeAdapter = {
    async probe(input) {
      const client = clientForKind(byKind, input.providerKind);
      return client.getJettonMetadata(input.jettonMaster);
    },
  };

  const derivation: JettonWalletDerivationProbeAdapter = {
    async probe(input) {
      const client = clientForKind(byKind, input.providerKind);
      return client.getJettonWalletAddress(input.jettonMaster, input.ownerAddress);
    },
  };

  return { identity, metadata, derivation, clients: { primary, secondary } };
}
