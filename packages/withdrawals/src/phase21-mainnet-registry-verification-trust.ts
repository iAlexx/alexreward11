/**
 * Runtime-branded Phase 21 Mainnet registry two-provider verification trust.
 * Caller-constructed { ok: true, networkGlobalId: -239, symbol: 'USDT' } cannot authorize.
 * Production mint ONLY via package-private runLivePhase21MainnetRegistryVerificationAndMintTrust
 * (CLI / ceremony path). Plain Phase21TwoProviderVerificationResult is never authority.
 */
import { authenticatedPhase21MainnetRegistryVerificationBrand } from './phase21-mainnet-registry-verification-mint-internal.js';

export const PHASE21_MAINNET_REGISTRY_VERIFICATION_TRUST_CLASS =
  'AuthenticatedPhase21MainnetRegistryVerification' as const;

export type Phase21MainnetRegistryVerificationTrustClass =
  typeof PHASE21_MAINNET_REGISTRY_VERIFICATION_TRUST_CLASS;

export interface AuthenticatedPhase21MainnetRegistryVerification {
  readonly brand: Phase21MainnetRegistryVerificationTrustClass;
  readonly trustClass: Phase21MainnetRegistryVerificationTrustClass;
  readonly networkCode: 'TON_MAINNET';
  readonly networkGlobalId: -239;
  readonly jettonMaster: string;
  readonly symbol: 'USDT';
  readonly decimals: 6;
  readonly primary: {
    readonly providerKind: string;
    readonly providerHost: string;
    readonly networkIdentity: '-239';
    readonly observedJettonMaster: string;
    readonly verificationMethod: string;
  };
  readonly secondary: {
    readonly providerKind: string;
    readonly providerHost: string;
    readonly networkIdentity: '-239';
    readonly observedJettonMaster: string;
    readonly verificationMethod: string;
  };
  readonly providersIndependent: true;
  readonly verifiedAt: string;
  readonly witnessModel: 'LIVE_TWO_PROVIDER_MAINNET';
}

export class Phase21MainnetRegistryVerificationError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21MainnetRegistryVerificationError';
    this.code = code;
    this.details = details;
  }
}

export function isAuthenticatedPhase21MainnetRegistryVerification(
  value: unknown,
): value is AuthenticatedPhase21MainnetRegistryVerification {
  return (
    typeof value === 'object' &&
    value !== null &&
    authenticatedPhase21MainnetRegistryVerificationBrand.has(value)
  );
}

export function assertAuthenticatedPhase21MainnetRegistryVerification(
  value: unknown,
): asserts value is AuthenticatedPhase21MainnetRegistryVerification {
  if (!isAuthenticatedPhase21MainnetRegistryVerification(value)) {
    throw new Phase21MainnetRegistryVerificationError(
      'MAINNET_REGISTRY_VERIFICATION_REQUIRED',
      'AuthenticatedPhase21MainnetRegistryVerification required - forged/raw/env verification cannot authorize',
      {},
    );
  }
}
