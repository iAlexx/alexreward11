/**
 * Runtime-branded Phase 21 Mainnet registry two-provider verification trust.
 * Caller-constructed { ok: true, networkGlobalId: -239, symbol: 'USDT' } cannot authorize.
 * Mint only via mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass
 * (or guarded test-only hooks).
 */
import { tonAddressesEqual } from '@alex-rewards/ton';

import type { Phase21TwoProviderVerificationResult } from './phase21-external-probes.js';
import {
  authenticatedPhase21MainnetRegistryVerificationBrand,
  mintAuthenticatedPhase21MainnetRegistryVerification,
} from './phase21-mainnet-registry-verification-mint-internal.js';

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
      'AuthenticatedPhase21MainnetRegistryVerification required — forged/raw/env verification cannot authorize',
      {},
    );
  }
}

/**
 * Mint branded Mainnet registry verification trust from a live two-provider PASS.
 * Refuses MOCK / SKIPPED / INCOMPLETE / UNAVAILABLE / forged plain result objects.
 * Requires PHASE21_EXTERNAL_PROBE_LIVE=1 so production APPLY cannot use skipped probes.
 */
export function mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass(input: {
  readonly verification: Phase21TwoProviderVerificationResult;
  readonly requestedJettonMaster: string;
}): AuthenticatedPhase21MainnetRegistryVerification {
  if (process.env.PHASE21_EXTERNAL_PROBE_LIVE !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'LIVE_PROBE_REQUIRED',
      'Mainnet registry verification trust requires PHASE21_EXTERNAL_PROBE_LIVE=1',
      {},
    );
  }

  const v = input.verification;
  if (v.incomplete === true) {
    throw new Phase21MainnetRegistryVerificationError(
      'INCOMPLETE_MAINNET_VERIFICATION',
      'incomplete two-provider verification cannot mint Mainnet registry trust',
      { code: v.code },
    );
  }
  if (!v.ok || v.code !== 'MAINNET_USDT_TWO_PROVIDER_OK') {
    throw new Phase21MainnetRegistryVerificationError(
      'MAINNET_VERIFICATION_NOT_PASS',
      'two-provider verification must be full PASS before minting Mainnet registry trust',
      { code: v.code, ok: v.ok },
    );
  }
  if (!v.independence.ok || v.independence.code !== 'PROVIDERS_INDEPENDENT') {
    throw new Phase21MainnetRegistryVerificationError(
      'PROVIDERS_NOT_INDEPENDENT',
      'provider kind+host independence required before minting Mainnet registry trust',
      { code: v.independence.code },
    );
  }
  if (v.primary === null || v.secondary === null) {
    throw new Phase21MainnetRegistryVerificationError(
      'PROVIDER_PROVENANCE_MISSING',
      'primary and secondary provider provenance required',
      {},
    );
  }
  if (v.primary.networkIdentity !== '-239' || v.secondary.networkIdentity !== '-239') {
    throw new Phase21MainnetRegistryVerificationError(
      'MAINNET_GLOBAL_ID_REQUIRED',
      'both providers must prove networkGlobalId=-239',
      {},
    );
  }
  if (v.primary.ok !== true || v.secondary.ok !== true) {
    throw new Phase21MainnetRegistryVerificationError(
      'PROVIDER_PROVENANCE_NOT_OK',
      'both provider provenance records must be ok=true',
      {},
    );
  }

  const boundMaster = (v.jettonMaster ?? '').trim();
  const requested = input.requestedJettonMaster.trim();
  const primaryObserved = (v.primaryObservedJettonMaster ?? '').trim();
  const secondaryObserved = (v.secondaryObservedJettonMaster ?? '').trim();
  if (
    boundMaster === '' ||
    requested === '' ||
    primaryObserved === '' ||
    secondaryObserved === '' ||
    !tonAddressesEqual(boundMaster, requested) ||
    !tonAddressesEqual(primaryObserved, requested) ||
    !tonAddressesEqual(secondaryObserved, requested)
  ) {
    throw new Phase21MainnetRegistryVerificationError(
      'EXACT_MASTER_MISMATCH',
      'requested / bound / primary observed / secondary observed Jetton masters must be canonically equal',
      {},
    );
  }
  if (v.symbol !== 'USDT' || v.decimals !== 6 || v.networkGlobalId !== -239) {
    throw new Phase21MainnetRegistryVerificationError(
      'USDT_METADATA_REQUIRED',
      'branded trust requires symbol=USDT decimals=6 networkGlobalId=-239',
      {},
    );
  }

  const primaryKind = v.primary.providerKind.trim();
  const secondaryKind = v.secondary.providerKind.trim();
  const primaryHost = v.primary.providerHost.trim();
  const secondaryHost = v.secondary.providerHost.trim();
  if (
    primaryKind === '' ||
    secondaryKind === '' ||
    primaryHost === '' ||
    secondaryHost === '' ||
    primaryKind.toLowerCase() === secondaryKind.toLowerCase() ||
    primaryHost.toLowerCase() === secondaryHost.toLowerCase()
  ) {
    throw new Phase21MainnetRegistryVerificationError(
      'PROVIDER_KIND_HOST_INDEPENDENCE_REQUIRED',
      'primary/secondary provider kind and normalized host must differ',
      {},
    );
  }

  const verifiedAt = (v.verifiedAt ?? v.primary.observedAt ?? '').trim();
  if (verifiedAt === '') {
    throw new Phase21MainnetRegistryVerificationError(
      'VERIFIED_AT_REQUIRED',
      'live verifiedAt timestamp required on two-provider PASS',
      {},
    );
  }

  return mintAuthenticatedPhase21MainnetRegistryVerification({
    jettonMaster: requested,
    verifiedAt,
    primary: {
      providerKind: primaryKind,
      providerHost: primaryHost,
      networkIdentity: '-239',
      observedJettonMaster: primaryObserved,
      verificationMethod: v.primary.verificationMethod,
    },
    secondary: {
      providerKind: secondaryKind,
      providerHost: secondaryHost,
      networkIdentity: '-239',
      observedJettonMaster: secondaryObserved,
      verificationMethod: v.secondary.verificationMethod,
    },
  });
}
