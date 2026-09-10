export interface SignerRuntimeConfig {
  readonly deploymentEnv: 'local' | 'test' | 'staging' | 'production';
  readonly spikeEnabled: boolean;
  readonly kmsMode: 'aws' | 'local_ephemeral';
  readonly kmsKeyArn: string | null;
  readonly networkCode: string;
  readonly networkGlobalId: number;
  readonly walletVersion: 'v5R1';
  readonly workchain: number;
  readonly expectedAssetSymbol: string;
}

export function localSigningFixtureConfig(
  overrides: Partial<SignerRuntimeConfig> = {},
): SignerRuntimeConfig {
  return {
    deploymentEnv: 'test',
    spikeEnabled: true,
    kmsMode: 'local_ephemeral',
    kmsKeyArn: null,
    networkCode: 'TON_TESTNET',
    networkGlobalId: -3,
    walletVersion: 'v5R1',
    workchain: 0,
    expectedAssetSymbol: 'USDT',
    ...overrides,
  };
}
