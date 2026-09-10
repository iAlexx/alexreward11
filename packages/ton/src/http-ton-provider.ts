export interface HttpTonProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  /** Must be TESTNET (-3). Mainnet (-239) is rejected. */
  readonly networkGlobalId?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * @deprecated The former adapter used non-existent JSON-RPC method names.
 * Construct TonCenterTestnetProvider or TonApiTestnetProvider instead.
 */
export class HttpTonProvider {
  constructor(_config: HttpTonProviderConfig) {
    void _config;
    throw new Error(
      'HttpTonProvider is removed: use TonCenterTestnetProvider or TonApiTestnetProvider',
    );
  }
}
