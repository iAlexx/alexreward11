import {
  TON_MAINNET_NETWORK_GLOBAL_ID,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  type TonChainProvider,
  type TonNetworkGlobalId,
} from './chain-provider.js';
import { TonApiTestnetProvider } from './tonapi-testnet-provider.js';
import { TonCenterTestnetProvider } from './toncenter-testnet-provider.js';

export type TonProviderKind = 'toncenter' | 'tonapi' | 'fake';

export function createTonChainProvider(input: {
  kind: TonProviderKind;
  baseUrl: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /** Required: never silently default to Testnet (-3). Pass -3 or -239 explicitly. */
  networkGlobalId: TonNetworkGlobalId;
}): TonChainProvider {
  if (
    input.networkGlobalId !== TON_TESTNET_NETWORK_GLOBAL_ID &&
    input.networkGlobalId !== TON_MAINNET_NETWORK_GLOBAL_ID
  ) {
    throw new Error(
      `createTonChainProvider requires explicit networkGlobalId -3 or -239 (got ${String(input.networkGlobalId)})`,
    );
  }
  const config = {
    baseUrl: input.baseUrl,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    networkGlobalId: input.networkGlobalId,
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
