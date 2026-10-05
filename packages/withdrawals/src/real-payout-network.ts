/**
 * Network-agnostic real payout binding shared by Phase 10 Testnet and Phase 21 Mainnet.
 */
import type { Phase10PayoutConfig, Phase10ProviderEndpointConfig } from './phase10-config.js';
import type { Phase21PayoutConfig } from './phase21-config.js';
import type { WithdrawalPayoutAuthority } from './phase21-runtime-selection.js';

export interface RealPayoutNetworkBinding {
  readonly authority: WithdrawalPayoutAuthority;
  readonly realChainEnabled: boolean;
  readonly signerBaseUrl: string;
  readonly signerServiceToken: string;
  readonly networkCode: string;
  readonly networkGlobalId: number;
  readonly jettonMasterIdentity: string | null;
  readonly primaryProvider: Phase10ProviderEndpointConfig;
  readonly secondaryProvider: Phase10ProviderEndpointConfig;
  readonly phase21MainnetEnabled: boolean;
}

export function realPayoutNetworkFromPhase10(
  config: Phase10PayoutConfig,
): RealPayoutNetworkBinding {
  return {
    authority: 'PHASE10_TESTNET',
    realChainEnabled: config.realChainEnabled,
    signerBaseUrl: config.signerBaseUrl,
    signerServiceToken: config.signerServiceToken,
    networkCode: config.networkCode,
    networkGlobalId: config.networkGlobalId,
    jettonMasterIdentity: config.jettonMasterIdentity,
    primaryProvider: config.primaryProvider,
    secondaryProvider: config.secondaryProvider,
    phase21MainnetEnabled: false,
  };
}

export function realPayoutNetworkFromPhase21(
  config: Phase21PayoutConfig,
): RealPayoutNetworkBinding {
  return {
    authority: 'PHASE21_MAINNET',
    realChainEnabled: config.realChainEnabled,
    signerBaseUrl: config.signerBaseUrl,
    signerServiceToken: config.signerServiceToken,
    networkCode: config.networkCode,
    networkGlobalId: config.networkGlobalId,
    jettonMasterIdentity: config.jettonMasterIdentity,
    primaryProvider: config.primaryProvider,
    secondaryProvider: config.secondaryProvider,
    phase21MainnetEnabled: true,
  };
}

export function resolveRealPayoutNetworkBinding(input: {
  readonly phase10?: Phase10PayoutConfig;
  readonly phase21?: Phase21PayoutConfig;
}): RealPayoutNetworkBinding {
  if (input.phase21 !== undefined) {
    return realPayoutNetworkFromPhase21(input.phase21);
  }
  if (input.phase10 !== undefined) {
    return realPayoutNetworkFromPhase10(input.phase10);
  }
  throw new Error('Real payout pipeline requires phase10 or phase21 payout config');
}
