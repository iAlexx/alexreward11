import { TON_TESTNET_NETWORK_GLOBAL_ID, type TonChainProvider, type TonNetworkGlobalId } from './chain-provider.js';
import { TonApiTestnetProvider } from './tonapi-testnet-provider.js';
import { TonCenterTestnetProvider } from './toncenter-testnet-provider.js';

export type TonProviderKind = 'toncenter' | 'tonapi' | 'fake';

export function createTonChainProvider(input: {
  kind: TonProviderKind;
  baseUrl: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  networkGlobalId?: TonNetworkGlobalId;
}): TonChainProvider {
  const config = {
    baseUrl: input.baseUrl,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    networkGlobalId: input.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID,
  };
  switch (input.kind) {
    case 'toncenter':
      return new TonCenterTestnetProvider(config);
    case 'tonapi':
      return new TonApiTestnetProvider(config);
    case 'fake':
      throw new Error(
        'FakeTonChainProvider is test-only and must be constructed directly in tests',
      );
  }
}
