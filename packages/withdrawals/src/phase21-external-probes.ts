/**
 * Phase 21 read-only external resource validation helpers.
 *
 * Live Mainnet RPC probes run ONLY when PHASE21_EXTERNAL_PROBE_LIVE=1 and provider URLs
 * are configured. Unit tests must not require live RPC (mock these runners).
 */
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

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
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
  const sameKind = primary.kind!.trim().toLowerCase() === secondary.kind!.trim().toLowerCase();
  const sameUrl = primary.url!.trim() === secondary.url!.trim();
  if (sameKind && sameUrl) {
    return {
      ok: false,
      code: 'PROVIDERS_NOT_INDEPENDENT',
      message: 'Secondary provider must differ from primary (kind or URL)',
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
}

/** Optional live read-only probe - never sends BOC / never signs. */
export async function runOptionalMainnetProviderReachabilityProbe(input: {
  readonly providerUrl: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<Phase21ExternalProbeResult> {
  const live = process.env.PHASE21_EXTERNAL_PROBE_LIVE === '1';
  if (!live) {
    return {
      probe: 'provider_reachability',
      ok: false,
      message: 'Live probe skipped (PHASE21_EXTERNAL_PROBE_LIVE!=1)',
    };
  }
  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(input.providerUrl, { method: 'GET' });
    return {
      probe: 'provider_reachability',
      ok: response.ok,
      message: response.ok
        ? 'Provider HTTP reachable'
        : 'Provider HTTP status ' + String(response.status),
    };
  } catch (error: unknown) {
    return {
      probe: 'provider_reachability',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}