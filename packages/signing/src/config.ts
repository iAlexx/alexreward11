import type { JettonTransferExecutionPolicy } from './jetton-transfer-policy.js';

export interface SignerRuntimeConfig {
  readonly deploymentEnv: 'local' | 'test' | 'staging' | 'production';
  readonly spikeEnabled: boolean;
  /** Production: self_hosted_encrypted. local/test may use local_ephemeral. */
  readonly keyMode: 'self_hosted_encrypted' | 'local_ephemeral';
  /** Expected Hot Wallet signer_reference = public key fingerprint (hex). */
  readonly expectedSignerReference: string | null;
  readonly keyBundlePath: string | null;
  readonly networkCode: string;
  readonly networkGlobalId: number;
  readonly walletVersion: 'v5R1';
  readonly workchain: number;
  readonly expectedAssetSymbol: string;
  /**
   * Explicit Phase 21 Mainnet allow-path. Default false preserves Phase 9 Testnet-only policy.
   * When true, require MAINNET / networkGlobalId -239. Never inferred from NODE_ENV.
   */
  readonly phase21MainnetEnabled: boolean;
  /** Owner-approved Mainnet jetton transfer gas policy (required when phase21MainnetEnabled). */
  readonly mainnetTransferPolicy?: JettonTransferExecutionPolicy | null;
}

export function localSigningFixtureConfig(
  overrides: Partial<SignerRuntimeConfig> = {},
): SignerRuntimeConfig {
  return {
    deploymentEnv: 'test',
    spikeEnabled: true,
    keyMode: 'local_ephemeral',
    expectedSignerReference: null,
    keyBundlePath: null,
    networkCode: 'TON_TESTNET',
    networkGlobalId: -3,
    walletVersion: 'v5R1',
    workchain: 0,
    expectedAssetSymbol: 'USDT',
    phase21MainnetEnabled: false,
    mainnetTransferPolicy: null,
    ...overrides,
  };
}
