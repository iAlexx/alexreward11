/**
 * PACKAGE-PRIVATE mint for AuthenticatedPhase21MainnetRegistryVerification.
 * Do not re-export mint from package root. Production mint goes through
 * mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass.
 * Test hooks may mint under dual disposable gates only.
 */
import type { AuthenticatedPhase21MainnetRegistryVerification } from './phase21-mainnet-registry-verification-trust.js';
import { PHASE21_MAINNET_REGISTRY_VERIFICATION_TRUST_CLASS } from './phase21-mainnet-registry-verification-trust.js';

export const authenticatedPhase21MainnetRegistryVerificationBrand = new WeakSet<object>();

export type Phase21MainnetRegistryVerificationProviderProvenance = {
  readonly providerKind: string;
  readonly providerHost: string;
  readonly networkIdentity: '-239';
  readonly observedJettonMaster: string;
  readonly verificationMethod: string;
};

export function mintAuthenticatedPhase21MainnetRegistryVerification(input: {
  readonly jettonMaster: string;
  readonly verifiedAt: string;
  readonly primary: Phase21MainnetRegistryVerificationProviderProvenance;
  readonly secondary: Phase21MainnetRegistryVerificationProviderProvenance;
}): AuthenticatedPhase21MainnetRegistryVerification {
  const obj: AuthenticatedPhase21MainnetRegistryVerification = {
    brand: PHASE21_MAINNET_REGISTRY_VERIFICATION_TRUST_CLASS,
    trustClass: PHASE21_MAINNET_REGISTRY_VERIFICATION_TRUST_CLASS,
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    jettonMaster: input.jettonMaster,
    symbol: 'USDT',
    decimals: 6,
    primary: input.primary,
    secondary: input.secondary,
    providersIndependent: true,
    verifiedAt: input.verifiedAt,
    witnessModel: 'LIVE_TWO_PROVIDER_MAINNET',
  };
  authenticatedPhase21MainnetRegistryVerificationBrand.add(obj);
  return obj;
}
