/**
 * Phase 21 read-only external resource validation helpers.
 *
 * Live Mainnet RPC probes run ONLY when PHASE21_EXTERNAL_PROBE_LIVE=1 and provider URLs
 * are configured. Unit tests must not require live RPC (mock these runners).
 * Bare HTTP 200 is never treated as Mainnet identity proof.
 */
import { tonAddressesEqual } from '@alex-rewards/ton';

import { PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS } from './phase21-config.js';

/** Minimal TON address shape check without @ton/core dependency in withdrawals package. */
function looksLikeTonAddress(value: string): boolean {
  if (/^(-1|0):[0-9a-fA-F]{64}$/.test(value)) return true;
  if (/^(E|U)Q[A-Za-z0-9_-]{46}$/.test(value)) return true;
  return false;
}

export interface Phase21JettonMasterValidation {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

export interface Phase21ProviderIndependenceValidation {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

export interface Phase21ExternalProbeProvider {
  readonly kind: string | null;
  readonly url: string | null;
}

export interface Phase21ProbeProvenance {
  readonly providerKind: string;
  readonly providerHost: string;
  readonly networkIdentity: string | null;
  readonly observedAt: string;
  readonly resource: string;
  readonly verificationMethod: string;
  readonly ok: boolean;
}

export interface MainnetIdentityProbeAdapter {
  probe(input: { providerKind: string; providerUrl: string }): Promise<{
    ok: boolean;
    networkGlobalId: number | null;
    message: string;
    providerHost: string;
    verificationClass?: string | null;
  }>;
}

export interface UsdtJettonMetadataProbeAdapter {
  probe(input: {
    providerKind: string;
    providerUrl: string;
    jettonMaster: string;
  }): Promise<{
    ok: boolean;
    symbol: string | null;
    decimals: number | null;
    observedJettonMaster: string | null;
    metadataSource?: string | null;
    message: string;
    providerHost: string;
  }>;
}

export interface JettonWalletDerivationProbeAdapter {
  probe(input: {
    providerKind: string;
    providerUrl: string;
    jettonMaster: string;
    ownerAddress: string;
  }): Promise<{
    ok: boolean;
    jettonWalletAddress: string | null;
    message: string;
    providerHost: string;
  }>;
}

export interface Phase21TwoProviderVerificationResult {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly incomplete?: boolean;
  readonly independence: Phase21ProviderIndependenceValidation;
  readonly primary: Phase21ProbeProvenance | null;
  readonly secondary: Phase21ProbeProvenance | null;
  /** Dual-provider derived Hot Wallet USDT Jetton wallet (when ownerAddress provided). */
  readonly primaryJettonWalletAddress?: string | null;
  readonly secondaryJettonWalletAddress?: string | null;
  readonly derivedJettonWalletsAgree?: boolean;
  /** Bound on full PASS only — used to mint branded Mainnet registry verification trust. */
  readonly networkCode?: 'TON_MAINNET';
  readonly networkGlobalId?: -239;
  readonly jettonMaster?: string;
  readonly primaryObservedJettonMaster?: string | null;
  readonly secondaryObservedJettonMaster?: string | null;
  readonly symbol?: 'USDT';
  readonly decimals?: 6;
  readonly verifiedAt?: string;
  /** Sanitized provider-observed display symbols (may be USD₮ before normalization). */
  readonly primaryObservedSymbol?: string | null;
  readonly secondaryObservedSymbol?: string | null;
  readonly primaryObservedDecimals?: number | null;
  readonly secondaryObservedDecimals?: number | null;
  readonly notes: readonly string[];
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Normalize official Tether USD Jetton *provider display* metadata symbols to the
 * internal LOOTRA/Alex Rewards canonical asset code USDT.
 *
 * Exact allowlist only (fail closed). No fuzzy / contains / casefold matching.
 * Recognized provider display variants:
 * - USDT (ASCII canonical / some providers)
 * - USD₮ (official Tether branded Tugrik-sign form)
 * - USDt (documented Tether ASCII fallback)
 */
export function normalizeOfficialTetherUsdMetadataSymbol(
  raw: string | null | undefined,
): 'USDT' | null {
  if (typeof raw !== 'string') return null;
  const symbol = raw.trim();
  if (symbol === 'USDT') return 'USDT';
  if (symbol === 'USD₮') return 'USDT';
  if (symbol === 'USDt') return 'USDT';
  return null;
}

function metadataDiagnostics(metaA: {
  readonly symbol: string | null;
  readonly decimals: number | null;
}, metaB: {
  readonly symbol: string | null;
  readonly decimals: number | null;
}): {
  readonly primaryObservedSymbol: string | null;
  readonly secondaryObservedSymbol: string | null;
  readonly primaryObservedDecimals: number | null;
  readonly secondaryObservedDecimals: number | null;
} {
  return {
    primaryObservedSymbol: metaA.symbol,
    secondaryObservedSymbol: metaB.symbol,
    primaryObservedDecimals: metaA.decimals,
    secondaryObservedDecimals: metaB.decimals,
  };
}

function isTrustworthyCanonicalUsdtMetadata(meta: {
  readonly ok: boolean;
  readonly symbol: string | null;
  readonly decimals: number | null;
}): boolean {
  return (
    meta.ok === true &&
    normalizeOfficialTetherUsdMetadataSymbol(meta.symbol) === 'USDT' &&
    meta.decimals === 6
  );
}

/**
 * Strip credentials and query/fragment; return hostname only.
 * Returns empty string when URL cannot be parsed.
 */
export function normalizeProviderHost(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.toLowerCase();
  } catch {
    // Tolerate host-only inputs without scheme for independence checks.
    try {
      const parsed = new URL(`https://${trimmed}`);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }
}

function hostAliases(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function validateMainnetJettonMasterAddress(
  identity: string | null | undefined,
): Phase21JettonMasterValidation {
  if (!nonEmpty(identity)) {
    return {
      ok: false,
      code: 'MAINNET_JETTON_MASTER_EMPTY',
      message: 'Mainnet USDT Jetton master address is required',
    };
  }
  const trimmed = identity!.trim();
  const upper = trimmed.toUpperCase();
  for (const forbidden of PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS) {
    if (upper === forbidden.toUpperCase() || upper.includes('TESTNET')) {
      return {
        ok: false,
        code: 'MAINNET_JETTON_MASTER_FORBIDDEN_PLACEHOLDER',
        message: 'Forbidden Testnet/local Jetton placeholder cannot be used as Mainnet master',
      };
    }
  }
  if (!looksLikeTonAddress(trimmed)) {
    return {
      ok: false,
      code: 'MAINNET_JETTON_MASTER_PARSE_FAILED',
      message: 'Mainnet Jetton master address failed TON address shape validation',
    };
  }
  return {
    ok: true,
    code: 'MAINNET_JETTON_MASTER_OK',
    message: 'Mainnet Jetton master address shape valid (on-chain verification separate)',
  };
}

/**
 * Require different vendor kind AND different normalized hostname.
 * Same kind fails even with different URLs. Hostname aliases fail.
 */
export function validateProviderIndependence(
  primary: Phase21ExternalProbeProvider,
  secondary: Phase21ExternalProbeProvider,
): Phase21ProviderIndependenceValidation {
  if (!nonEmpty(primary.kind) || !nonEmpty(primary.url)) {
    return {
      ok: false,
      code: 'PRIMARY_PROVIDER_INCOMPLETE',
      message: 'Primary provider kind and URL required before independence check',
    };
  }
  if (!nonEmpty(secondary.kind) || !nonEmpty(secondary.url)) {
    return {
      ok: false,
      code: 'SECONDARY_PROVIDER_INCOMPLETE',
      message: 'Secondary provider kind and URL required before independence check',
    };
  }
  const kindA = primary.kind!.trim().toLowerCase();
  const kindB = secondary.kind!.trim().toLowerCase();
  if (kindA === kindB) {
    return {
      ok: false,
      code: 'PROVIDERS_NOT_INDEPENDENT',
      message: 'Secondary provider must use a different vendor kind than primary',
    };
  }
  const hostA = normalizeProviderHost(primary.url!);
  const hostB = normalizeProviderHost(secondary.url!);
  if (hostA.length === 0 || hostB.length === 0) {
    return {
      ok: false,
      code: 'PROVIDER_HOST_UNPARSEABLE',
      message: 'Provider URL hostname could not be normalized',
    };
  }
  if (hostA === hostB || hostAliases(hostA, hostB)) {
    return {
      ok: false,
      code: 'PROVIDERS_NOT_INDEPENDENT',
      message: 'Secondary provider hostname must differ and must not alias primary',
    };
  }
  return {
    ok: true,
    code: 'PROVIDERS_INDEPENDENT',
    message: 'Primary and secondary providers are operationally independent',
  };
}

export interface Phase21ExternalProbeResult {
  readonly probe: string;
  readonly ok: boolean;
  readonly message: string;
  readonly incomplete?: boolean;
  readonly provenance?: Phase21ProbeProvenance;
}

/**
 * Optional live reachability probe — never treats bare HTTP 200 as Mainnet identity.
 * When an identity adapter is supplied, use it; otherwise return incomplete/unavailable.
 */
export async function runOptionalMainnetProviderReachabilityProbe(input: {
  readonly providerUrl: string;
  readonly providerKind?: string;
  readonly fetchImpl?: typeof fetch;
  readonly identityAdapter?: MainnetIdentityProbeAdapter;
}): Promise<Phase21ExternalProbeResult> {
  const live = process.env.PHASE21_EXTERNAL_PROBE_LIVE === '1';
  if (!live) {
    return {
      probe: 'provider_reachability',
      ok: false,
      message: 'Live probe skipped (PHASE21_EXTERNAL_PROBE_LIVE!=1)',
      incomplete: true,
    };
  }

  if (input.identityAdapter !== undefined) {
    const kind = input.providerKind?.trim() || 'unknown';
    try {
      const identity = await input.identityAdapter.probe({
        providerKind: kind,
        providerUrl: input.providerUrl,
      });
      const mainnetOk = identity.ok && identity.networkGlobalId === -239;
      return {
        probe: 'provider_reachability',
        ok: mainnetOk,
        incomplete: !mainnetOk,
        message: mainnetOk
          ? 'Provider Mainnet identity confirmed (-239)'
          : `Provider identity incomplete or not Mainnet: ${identity.message}`,
        provenance: {
          providerKind: kind,
          providerHost: identity.providerHost || normalizeProviderHost(input.providerUrl),
          networkIdentity:
            identity.networkGlobalId === null ? null : String(identity.networkGlobalId),
          observedAt: new Date().toISOString(),
          resource: 'network_identity',
          verificationMethod: 'identity_adapter',
          ok: mainnetOk,
        },
      };
    } catch (error: unknown) {
      return {
        probe: 'provider_reachability',
        ok: false,
        incomplete: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Without identity adapter: may check HTTP reachability but MUST NOT claim Mainnet identity.
  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(input.providerUrl, { method: 'GET' });
    return {
      probe: 'provider_reachability',
      ok: false,
      incomplete: true,
      message: response.ok
        ? 'Provider HTTP reachable but Mainnet identity not proven (bare HTTP 200 is insufficient)'
        : `Provider HTTP status ${String(response.status)}; Mainnet identity not proven`,
      provenance: {
        providerKind: input.providerKind?.trim() || 'unknown',
        providerHost: normalizeProviderHost(input.providerUrl),
        networkIdentity: null,
        observedAt: new Date().toISOString(),
        resource: 'http_reachability',
        verificationMethod: 'http_get_no_identity',
        ok: false,
      },
    };
  } catch (error: unknown) {
    return {
      probe: 'provider_reachability',
      ok: false,
      incomplete: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Orchestrate two-provider Mainnet USDT verification. Fail closed on mismatch.
 * Never broadcasts.
 */
export async function verifyMainnetUsdtWithTwoProviders(input: {
  readonly primary: Phase21ExternalProbeProvider;
  readonly secondary: Phase21ExternalProbeProvider;
  readonly jettonMaster: string;
  readonly ownerAddress?: string;
  readonly identityAdapter: MainnetIdentityProbeAdapter;
  readonly metadataAdapter: UsdtJettonMetadataProbeAdapter;
  readonly walletDerivationAdapter?: JettonWalletDerivationProbeAdapter;
}): Promise<Phase21TwoProviderVerificationResult> {
  const observedAt = new Date().toISOString();
  const independence = validateProviderIndependence(input.primary, input.secondary);
  if (!independence.ok) {
    return {
      ok: false,
      code: independence.code,
      message: independence.message,
      independence,
      primary: null,
      secondary: null,
      notes: ['Fail closed: providers not independent', 'No broadcast'],
    };
  }

  const jettonCheck = validateMainnetJettonMasterAddress(input.jettonMaster);
  if (!jettonCheck.ok) {
    return {
      ok: false,
      code: jettonCheck.code,
      message: jettonCheck.message,
      independence,
      primary: null,
      secondary: null,
      notes: ['Fail closed: Jetton master invalid', 'No broadcast'],
    };
  }

  const primaryKind = input.primary.kind!.trim();
  const secondaryKind = input.secondary.kind!.trim();
  const primaryUrl = input.primary.url!.trim();
  const secondaryUrl = input.secondary.url!.trim();

  const [idA, idB] = await Promise.all([
    input.identityAdapter.probe({ providerKind: primaryKind, providerUrl: primaryUrl }),
    input.identityAdapter.probe({ providerKind: secondaryKind, providerUrl: secondaryUrl }),
  ]);

  const primaryIdentityOk = idA.ok && idA.networkGlobalId === -239;
  const secondaryIdentityOk = idB.ok && idB.networkGlobalId === -239;
  if (!primaryIdentityOk || !secondaryIdentityOk) {
    return {
      ok: false,
      code: 'MAINNET_IDENTITY_FAILED',
      message: 'One or both providers failed Mainnet identity (-239) probe',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: idA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: idA.networkGlobalId === null ? null : String(idA.networkGlobalId),
        observedAt,
        resource: 'network_identity',
        verificationMethod: 'identity_adapter',
        ok: primaryIdentityOk,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: idB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: idB.networkGlobalId === null ? null : String(idB.networkGlobalId),
        observedAt,
        resource: 'network_identity',
        verificationMethod: 'identity_adapter',
        ok: secondaryIdentityOk,
      },
      notes: [idA.message, idB.message, 'No broadcast'],
    };
  }

  const [metaA, metaB] = await Promise.all([
    input.metadataAdapter.probe({
      providerKind: primaryKind,
      providerUrl: primaryUrl,
      jettonMaster: input.jettonMaster,
    }),
    input.metadataAdapter.probe({
      providerKind: secondaryKind,
      providerUrl: secondaryUrl,
      jettonMaster: input.jettonMaster,
    }),
  ]);

  const metaAOk = isTrustworthyCanonicalUsdtMetadata(metaA);
  const metaBOk = isTrustworthyCanonicalUsdtMetadata(metaB);
  const observedSymbols = metadataDiagnostics(metaA, metaB);
  const canonicalSymbolA = normalizeOfficialTetherUsdMetadataSymbol(metaA.symbol);
  const canonicalSymbolB = normalizeOfficialTetherUsdMetadataSymbol(metaB.symbol);

  if (metaAOk !== metaBOk) {
    return {
      ok: false,
      incomplete: true,
      code: 'USDT_METADATA_INCOMPLETE',
      message:
        'Only one provider returned trustworthy USDT metadata (canonical symbol=USDT decimals=6); dual-provider gate incomplete',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: metaAOk,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: metaBOk,
      },
      ...observedSymbols,
      notes: [
        metaA.message,
        metaB.message,
        `primaryObservedSymbol=${metaA.symbol ?? 'null'}`,
        `secondaryObservedSymbol=${metaB.symbol ?? 'null'}`,
        `primaryObservedDecimals=${metaA.decimals === null ? 'null' : String(metaA.decimals)}`,
        `secondaryObservedDecimals=${metaB.decimals === null ? 'null' : String(metaB.decimals)}`,
        'INCOMPLETE not PASS',
        'No broadcast',
      ],
    };
  }

  if (!metaAOk || !metaBOk) {
    return {
      ok: false,
      code: 'USDT_METADATA_MISMATCH',
      message:
        'USDT metadata must normalize to canonical symbol=USDT with decimals=6 on both providers',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: metaAOk,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: metaBOk,
      },
      ...observedSymbols,
      notes: [
        metaA.message,
        metaB.message,
        `primaryObservedSymbol=${metaA.symbol ?? 'null'}`,
        `secondaryObservedSymbol=${metaB.symbol ?? 'null'}`,
        `primaryObservedDecimals=${metaA.decimals === null ? 'null' : String(metaA.decimals)}`,
        `secondaryObservedDecimals=${metaB.decimals === null ? 'null' : String(metaB.decimals)}`,
        'No broadcast',
      ],
    };
  }

  // Compare *canonical* symbols so USD₮ vs USDT (or USDt) may agree after normalization.
  if (
    canonicalSymbolA !== 'USDT' ||
    canonicalSymbolB !== 'USDT' ||
    canonicalSymbolA !== canonicalSymbolB ||
    metaA.decimals !== metaB.decimals
  ) {
    return {
      ok: false,
      code: 'PROVIDER_METADATA_DISAGREE',
      message: 'Primary and secondary USDT metadata disagree after canonical normalization',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: false,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: false,
      },
      ...observedSymbols,
      notes: [
        'Fail closed on provider disagreement',
        `primaryObservedSymbol=${metaA.symbol ?? 'null'}`,
        `secondaryObservedSymbol=${metaB.symbol ?? 'null'}`,
        `primaryObservedDecimals=${metaA.decimals === null ? 'null' : String(metaA.decimals)}`,
        `secondaryObservedDecimals=${metaB.decimals === null ? 'null' : String(metaB.decimals)}`,
        'No broadcast',
      ],
    };
  }

  const observedA = metaA.observedJettonMaster;
  const observedB = metaB.observedJettonMaster;
  const masterMatchesRequested =
    observedA !== null &&
    observedB !== null &&
    tonAddressesEqual(observedA, input.jettonMaster) &&
    tonAddressesEqual(observedB, input.jettonMaster) &&
    tonAddressesEqual(observedA, observedB);

  if (!masterMatchesRequested) {
    return {
      ok: false,
      code: 'OBSERVED_JETTON_MASTER_MISMATCH',
      message:
        'Observed jetton master from one or both providers does not equal requested master (canonical Address equality)',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: false,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata',
        verificationMethod: 'metadata_adapter',
        ok: false,
      },
      notes: [
        `requested=${input.jettonMaster}`,
        `primaryObserved=${observedA ?? 'null'}`,
        `secondaryObserved=${observedB ?? 'null'}`,
        'No broadcast',
      ],
    };
  }

  if (
    input.walletDerivationAdapter !== undefined &&
    nonEmpty(input.ownerAddress)
  ) {
    const [wA, wB] = await Promise.all([
      input.walletDerivationAdapter.probe({
        providerKind: primaryKind,
        providerUrl: primaryUrl,
        jettonMaster: input.jettonMaster,
        ownerAddress: input.ownerAddress!,
      }),
      input.walletDerivationAdapter.probe({
        providerKind: secondaryKind,
        providerUrl: secondaryUrl,
        jettonMaster: input.jettonMaster,
        ownerAddress: input.ownerAddress!,
      }),
    ]);
    if (
      !wA.ok ||
      !wB.ok ||
      wA.jettonWalletAddress === null ||
      wB.jettonWalletAddress === null ||
      !tonAddressesEqual(wA.jettonWalletAddress, wB.jettonWalletAddress)
    ) {
      return {
        ok: false,
        code: 'JETTON_WALLET_DERIVATION_DISAGREE',
        message: 'Jetton wallet derivation failed or disagreed across providers',
        independence,
        primary: {
          providerKind: primaryKind,
          providerHost: wA.providerHost || normalizeProviderHost(primaryUrl),
          networkIdentity: '-239',
          observedAt,
          resource: 'jetton_wallet_derivation',
          verificationMethod: 'wallet_derivation_adapter',
          ok: false,
        },
        secondary: {
          providerKind: secondaryKind,
          providerHost: wB.providerHost || normalizeProviderHost(secondaryUrl),
          networkIdentity: '-239',
          observedAt,
          resource: 'jetton_wallet_derivation',
          verificationMethod: 'wallet_derivation_adapter',
          ok: false,
        },
        primaryJettonWalletAddress: wA.jettonWalletAddress,
        secondaryJettonWalletAddress: wB.jettonWalletAddress,
        derivedJettonWalletsAgree: false,
        notes: [wA.message, wB.message, 'No broadcast'],
      };
    }

    return {
      ok: true,
      code: 'MAINNET_USDT_TWO_PROVIDER_OK',
      message:
        'Mainnet identity (-239), USDT metadata, and Jetton wallet derivation agreed across independent providers',
      independence,
      primary: {
        providerKind: primaryKind,
        providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata_and_wallet_derivation',
        verificationMethod: 'two_provider_orchestrated',
        ok: true,
      },
      secondary: {
        providerKind: secondaryKind,
        providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
        networkIdentity: '-239',
        observedAt,
        resource: 'jetton_metadata_and_wallet_derivation',
        verificationMethod: 'two_provider_orchestrated',
        ok: true,
      },
      primaryJettonWalletAddress: wA.jettonWalletAddress,
      secondaryJettonWalletAddress: wB.jettonWalletAddress,
      derivedJettonWalletsAgree: true,
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMaster: input.jettonMaster.trim(),
      primaryObservedJettonMaster: observedA,
      secondaryObservedJettonMaster: observedB,
      symbol: 'USDT',
      decimals: 6,
      verifiedAt: observedAt,
      ...observedSymbols,
      notes: [
        'Read-only verification only',
        'No broadcast',
        'DUAL_PROVIDER_LIVE derivation ready',
        `primaryObservedSymbol=${metaA.symbol ?? 'null'}`,
        `secondaryObservedSymbol=${metaB.symbol ?? 'null'}`,
      ],
    };
  }

  return {
    ok: true,
    code: 'MAINNET_USDT_TWO_PROVIDER_OK',
    message: 'Mainnet identity (-239) and USDT metadata agreed across independent providers',
    independence,
    primary: {
      providerKind: primaryKind,
      providerHost: metaA.providerHost || normalizeProviderHost(primaryUrl),
      networkIdentity: '-239',
      observedAt,
      resource: 'jetton_metadata',
      verificationMethod: 'two_provider_orchestrated',
      ok: true,
    },
    secondary: {
      providerKind: secondaryKind,
      providerHost: metaB.providerHost || normalizeProviderHost(secondaryUrl),
      networkIdentity: '-239',
      observedAt,
      resource: 'jetton_metadata',
      verificationMethod: 'two_provider_orchestrated',
      ok: true,
    },
    primaryJettonWalletAddress: null,
    secondaryJettonWalletAddress: null,
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    jettonMaster: input.jettonMaster.trim(),
    primaryObservedJettonMaster: observedA,
    secondaryObservedJettonMaster: observedB,
    symbol: 'USDT',
    decimals: 6,
    verifiedAt: observedAt,
    ...observedSymbols,
    notes: [
      'Read-only verification only',
      'No broadcast',
      'ownerAddress absent — Jetton wallet derivation skipped',
      `primaryObservedSymbol=${metaA.symbol ?? 'null'}`,
      `secondaryObservedSymbol=${metaB.symbol ?? 'null'}`,
    ],
  };
}
