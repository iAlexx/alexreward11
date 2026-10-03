/**
 * Package-private live Mainnet registry verification + trust mint.
 * NOT re-exported from @alex-rewards/withdrawals package root.
 * Production callers must use runLivePhase21MainnetRegistryVerificationAndMintTrust
 * with concrete provider endpoints only — never plain verification results / adapters.
 */
import { tonAddressesEqual } from '@alex-rewards/ton';

import { createPhase21MainnetExternalAdapters } from './phase21-mainnet-adapters.js';
import {
  validateProviderIndependence,
  verifyMainnetUsdtWithTwoProviders,
  type Phase21TwoProviderVerificationResult,
} from './phase21-external-probes.js';
import { mintAuthenticatedPhase21MainnetRegistryVerification } from './phase21-mainnet-registry-verification-mint-internal.js';
import {
  Phase21MainnetRegistryVerificationError,
  assertAuthenticatedPhase21MainnetRegistryVerification,
  type AuthenticatedPhase21MainnetRegistryVerification,
} from './phase21-mainnet-registry-verification-trust.js';

/** Hardcoded in-memory freshness window before registry mutation (not env-tunable). */
export const PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_MS = 120_000;
export const PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_SECONDS =
  PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_MS / 1000;

export type Phase21MainnetRegistryLiveVerifyMintInput = {
  readonly jettonMaster: string;
  readonly primary: {
    readonly kind: string;
    readonly url: string;
    readonly apiKey?: string | null;
  };
  readonly secondary: {
    readonly kind: string;
    readonly url: string;
    readonly apiKey?: string | null;
  };
};

export type Phase21MainnetRegistryLiveVerifyMintResult = {
  readonly trust: AuthenticatedPhase21MainnetRegistryVerification;
  /** Diagnostic only — never reusable as APPLY authority. */
  readonly diagnostic: Phase21TwoProviderVerificationResult;
};

function parseProviderKind(raw: string): 'toncenter' | 'tonapi' {
  const kind = raw.trim().toLowerCase();
  if (kind === 'toncenter' || kind === 'tonapi') return kind;
  throw new Phase21MainnetRegistryVerificationError(
    'INVALID_PROVIDER_KIND',
    `provider kind must be toncenter|tonapi; got ${raw.trim() || '(empty)'}`,
    {},
  );
}

function requireLiveProbeEnv(): void {
  if (process.env.PHASE21_EXTERNAL_PROBE_LIVE !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'LIVE_PROBE_REQUIRED',
      'Mainnet registry live verify+mint requires PHASE21_EXTERNAL_PROBE_LIVE=1',
      {},
    );
  }
}

/**
 * Mint branded trust ONLY from an in-process orchestrated PASS.
 * Not exported from package root. Must not be called with caller-forged objects
 * from production public API — only after concrete adapter execution in this module.
 */
function mintTrustFromOrchestratedLivePass(
  verification: Phase21TwoProviderVerificationResult,
  requestedJettonMaster: string,
): AuthenticatedPhase21MainnetRegistryVerification {
  const v = verification;
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
  const requested = requestedJettonMaster.trim();
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

export function assertPhase21MainnetRegistryVerificationFresh(
  trust: AuthenticatedPhase21MainnetRegistryVerification,
  nowMs: number = Date.now(),
): void {
  assertAuthenticatedPhase21MainnetRegistryVerification(trust);
  const verifiedMs = Date.parse(trust.verifiedAt);
  if (!Number.isFinite(verifiedMs)) {
    throw new Phase21MainnetRegistryVerificationError(
      'VERIFIED_AT_INVALID',
      'Mainnet registry verification verifiedAt is not a valid timestamp',
      {},
    );
  }
  if (verifiedMs > nowMs + 60_000) {
    throw new Phase21MainnetRegistryVerificationError(
      'VERIFIED_AT_CLOCK_SKEW',
      'Mainnet registry verification verifiedAt is unreasonably in the future',
      {},
    );
  }
  if (nowMs - verifiedMs > PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_MS) {
    throw new Phase21MainnetRegistryVerificationError(
      'MAINNET_VERIFICATION_STALE',
      `Mainnet registry verification older than ${String(PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_SECONDS)}s — rerun live provider verification`,
      {
        maxAgeSeconds: PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_SECONDS,
      },
    );
  }
}

async function executeLiveVerifyAndMint(
  input: Phase21MainnetRegistryLiveVerifyMintInput,
  fetchImpl: typeof fetch | undefined,
): Promise<Phase21MainnetRegistryLiveVerifyMintResult> {
  requireLiveProbeEnv();
  const jettonMaster = input.jettonMaster.trim();
  if (jettonMaster === '') {
    throw new Phase21MainnetRegistryVerificationError(
      'USDT_MASTER_REQUIRED',
      'jettonMaster required for live Mainnet registry verification',
      {},
    );
  }
  const primaryKind = parseProviderKind(input.primary.kind);
  const secondaryKind = parseProviderKind(input.secondary.kind);
  const primaryUrl = input.primary.url.trim();
  const secondaryUrl = input.secondary.url.trim();
  if (primaryUrl === '' || secondaryUrl === '') {
    throw new Phase21MainnetRegistryVerificationError(
      'PROVIDER_URL_REQUIRED',
      'primary and secondary provider URLs required',
      {},
    );
  }

  const independence = validateProviderIndependence(
    { kind: primaryKind, url: primaryUrl },
    { kind: secondaryKind, url: secondaryUrl },
  );
  if (!independence.ok) {
    throw new Phase21MainnetRegistryVerificationError(
      independence.code,
      independence.message,
      {},
    );
  }

  const adapters = createPhase21MainnetExternalAdapters({
    primary: {
      kind: primaryKind,
      url: primaryUrl,
      apiKey: input.primary.apiKey ?? null,
    },
    secondary: {
      kind: secondaryKind,
      url: secondaryUrl,
      apiKey: input.secondary.apiKey ?? null,
    },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  const diagnostic = await verifyMainnetUsdtWithTwoProviders({
    primary: { kind: primaryKind, url: primaryUrl },
    secondary: { kind: secondaryKind, url: secondaryUrl },
    jettonMaster,
    identityAdapter: adapters.identity,
    metadataAdapter: adapters.metadata,
  });

  if (!diagnostic.ok || diagnostic.incomplete === true) {
    throw new Phase21MainnetRegistryVerificationError(
      diagnostic.code,
      diagnostic.message,
      { notes: diagnostic.notes },
    );
  }

  const trust = mintTrustFromOrchestratedLivePass(diagnostic, jettonMaster);
  return { trust, diagnostic };
}

/**
 * Production live verify+mint. Accepts ONLY concrete provider endpoints.
 * Does NOT accept adapters, fetchImpl, precomputed results, or plain provenance.
 */
export async function runLivePhase21MainnetRegistryVerificationAndMintTrust(
  input: Phase21MainnetRegistryLiveVerifyMintInput,
): Promise<Phase21MainnetRegistryLiveVerifyMintResult> {
  return executeLiveVerifyAndMint(input, undefined);
}

function requireSimulatedLiveTestGates(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'simulated live Mainnet verify+mint requires NODE_ENV=test',
      {},
    );
  }
  if (process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'simulated live Mainnet verify+mint requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'simulated live Mainnet verify+mint requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
      {},
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM !== '1') {
    throw new Phase21MainnetRegistryVerificationError(
      'FORBIDDEN',
      'simulated live Mainnet verify+mint requires ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM=1',
      {},
    );
  }
}

/**
 * Test-only simulated live path with controlled fetchImpl.
 * NOT re-exported from package root. Requires dual disposable gates + ceremony hooks.
 */
export async function __runSimulatedLivePhase21MainnetRegistryVerificationAndMintTrustForTests(
  input: Phase21MainnetRegistryLiveVerifyMintInput & {
    readonly fetchImpl: typeof fetch;
  },
): Promise<Phase21MainnetRegistryLiveVerifyMintResult> {
  requireSimulatedLiveTestGates();
  return executeLiveVerifyAndMint(input, input.fetchImpl);
}
