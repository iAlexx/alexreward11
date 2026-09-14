/**
 * Read-only Phase 10 live external probes (providers + Signer).
 * Never signs, unlocks, broadcasts, or returns secrets/API keys/tokens.
 */

import { createTonChainProvider, type TonProviderKind } from '@alex-rewards/ton';

export const PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN = 'PROVIDER_INDEPENDENCE_UNPROVEN' as const;

export interface Phase10ProviderEndpointConfig {
  readonly kind: string | null;
  readonly baseUrl: string | null;
  /** Used only for live probe HTTP; never emitted in evidence. */
  readonly apiKey?: string | null;
}

export interface Phase10ProviderProbeObservation {
  readonly kind: string | null;
  /** Redacted endpoint identity (origin/host fingerprint) — never includes API key. */
  readonly endpointFingerprint: string | null;
  readonly reachable: boolean;
  readonly healthy: boolean;
  readonly observedNetworkGlobalId: number | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

export interface Phase10SignerProbeObservation {
  readonly probePerformed: boolean;
  readonly healthReachable: boolean;
  readonly custodyState: string | null;
  readonly signingReady: boolean;
  readonly expectedCustodyMode: string | null;
  readonly identityProbed: boolean;
  readonly publicKeyFingerprint: string | null;
  readonly walletAddressRaw: string | null;
  readonly identityMatchesExpected: boolean | null;
  readonly httpStatus: number | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

export interface Phase10LiveExternalProbeEvidence {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly primary: Phase10ProviderProbeObservation;
  readonly secondary: Phase10ProviderProbeObservation;
  readonly providerIndependence: {
    readonly proven: boolean;
    readonly code: typeof PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN | null;
    readonly reason: string | null;
    readonly primaryFingerprint: string | null;
    readonly secondaryFingerprint: string | null;
  };
  readonly signer: Phase10SignerProbeObservation;
  readonly overallBlocked: boolean;
  readonly blockers: readonly string[];
}

export interface Phase10LiveExternalProbeInput {
  readonly primary: Phase10ProviderEndpointConfig;
  readonly secondary: Phase10ProviderEndpointConfig;
  readonly signerBaseUrl: string | null;
  /** Optional Bearer token for identity probe only — never written to evidence. */
  readonly signerServiceToken?: string | null;
  /** Expected custody mode label (e.g. self_hosted_encrypted). Observational only. */
  readonly expectedCustodyMode?: string | null;
  /** Optional expected public-key fingerprint (hex) when identity is probed. */
  readonly expectedPublicKeyFingerprint?: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Injected probe ports for deterministic tests (skip live HTTP). */
  readonly inject?: {
    readonly primaryHealth?: () => Promise<{
      ok: boolean;
      networkGlobalId: number;
      latencyMs?: number;
      detail?: string;
    }>;
    readonly secondaryHealth?: () => Promise<{
      ok: boolean;
      networkGlobalId: number;
      latencyMs?: number;
      detail?: string;
    }>;
    readonly signerReady?: () => Promise<{
      reachable: boolean;
      httpStatus: number;
      signingReady: boolean;
      custodyState: string;
      detail?: string;
    }>;
    readonly signerIdentity?: () => Promise<{
      publicKeyFingerprint: string;
      walletAddressRaw: string;
      signingReady: boolean;
      custodyState: string;
    } | null>;
  };
}

/**
 * Normalize provider URL to an effective origin/host fingerprint (no credentials/path noise).
 */
export function fingerprintProviderEndpoint(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const trimmed = url.trim();
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const port =
      parsed.port !== ''
        ? parsed.port
        : protocol === 'https:'
          ? '443'
          : protocol === 'http:'
            ? '80'
            : '';
    return `${protocol}//${host}:${port}`;
  } catch {
    // Fall back to lowercased trimmed string without query/fragment.
    const noQuery = trimmed.split('?')[0]?.split('#')[0] ?? trimmed;
    return noQuery.trim().toLowerCase();
  }
}

export function evaluateProviderIndependence(input: {
  readonly primaryKind: string | null;
  readonly secondaryKind: string | null;
  readonly primaryUrl: string | null;
  readonly secondaryUrl: string | null;
}): {
  readonly proven: boolean;
  readonly code: typeof PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN | null;
  readonly reason: string | null;
  readonly primaryFingerprint: string | null;
  readonly secondaryFingerprint: string | null;
} {
  const primaryFingerprint = fingerprintProviderEndpoint(input.primaryUrl);
  const secondaryFingerprint = fingerprintProviderEndpoint(input.secondaryUrl);
  const primaryKind = input.primaryKind?.trim().toLowerCase() || null;
  const secondaryKind = input.secondaryKind?.trim().toLowerCase() || null;

  if (
    primaryKind === null ||
    secondaryKind === null ||
    primaryFingerprint === null ||
    secondaryFingerprint === null
  ) {
    return {
      proven: false,
      code: PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN,
      reason: 'primary and secondary kind+URL required to prove independence',
      primaryFingerprint,
      secondaryFingerprint,
    };
  }

  if (primaryFingerprint === secondaryFingerprint) {
    return {
      proven: false,
      code: PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN,
      reason: 'primary and secondary resolve to the same effective origin/host',
      primaryFingerprint,
      secondaryFingerprint,
    };
  }

  // Different effective backends with configured kinds — independence proven at URL layer.
  return {
    proven: true,
    code: null,
    reason: null,
    primaryFingerprint,
    secondaryFingerprint,
  };
}

async function probeOneProvider(
  label: 'primary' | 'secondary',
  config: Phase10ProviderEndpointConfig,
  injectHealth:
    | (() => Promise<{
        ok: boolean;
        networkGlobalId: number;
        latencyMs?: number;
        detail?: string;
      }>)
    | undefined,
): Promise<Phase10ProviderProbeObservation> {
  const observedAt = new Date().toISOString();
  const kind = config.kind?.trim() || null;
  const endpointFingerprint = fingerprintProviderEndpoint(config.baseUrl);
  if (kind === null || endpointFingerprint === null || config.baseUrl === null) {
    return {
      kind,
      endpointFingerprint,
      reachable: false,
      healthy: false,
      observedNetworkGlobalId: null,
      latencyMs: null,
      detail: `${label} provider kind/url not configured`,
      observedAt,
    };
  }

  try {
    const started = Date.now();
    const health =
      injectHealth !== undefined
        ? await injectHealth()
        : await createTonChainProvider({
            kind: kind as TonProviderKind,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey ?? null,
          }).health();
    const latencyMs = health.latencyMs ?? Date.now() - started;
    return {
      kind,
      endpointFingerprint,
      reachable: true,
      healthy: health.ok === true,
      observedNetworkGlobalId: health.networkGlobalId,
      latencyMs,
      detail: health.detail ?? null,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      kind,
      endpointFingerprint,
      reachable: false,
      healthy: false,
      observedNetworkGlobalId: null,
      latencyMs: null,
      detail: error instanceof Error ? error.message : String(error),
      observedAt: new Date().toISOString(),
    };
  }
}

async function probeSignerReady(
  baseUrl: string | null,
  fetchImpl: typeof fetch,
  inject?: Phase10LiveExternalProbeInput['inject'],
): Promise<{
  reachable: boolean;
  httpStatus: number | null;
  signingReady: boolean;
  custodyState: string | null;
  detail: string | null;
}> {
  if (inject?.signerReady !== undefined) {
    const r = await inject.signerReady();
    return {
      reachable: r.reachable,
      httpStatus: r.httpStatus,
      signingReady: r.signingReady,
      custodyState: r.custodyState,
      detail: r.detail ?? null,
    };
  }
  if (baseUrl === null || baseUrl.trim() === '') {
    return {
      reachable: false,
      httpStatus: null,
      signingReady: false,
      custodyState: null,
      detail: 'signer base URL not configured',
    };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/health/ready`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const signingReady = body.signingReady === true;
    const custodyState =
      typeof body.custodyState === 'string' && body.custodyState.trim() !== ''
        ? body.custodyState.trim()
        : null;
    return {
      reachable: true,
      httpStatus: response.status,
      signingReady,
      custodyState,
      detail: response.ok ? null : `signer /health/ready HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      httpStatus: null,
      signingReady: false,
      custodyState: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeSignerIdentity(
  baseUrl: string | null,
  serviceToken: string | null | undefined,
  fetchImpl: typeof fetch,
  inject?: Phase10LiveExternalProbeInput['inject'],
): Promise<{
  identityProbed: boolean;
  publicKeyFingerprint: string | null;
  walletAddressRaw: string | null;
  signingReady: boolean | null;
  custodyState: string | null;
  detail: string | null;
}> {
  if (inject?.signerIdentity !== undefined) {
    const r = await inject.signerIdentity();
    if (r === null) {
      return {
        identityProbed: false,
        publicKeyFingerprint: null,
        walletAddressRaw: null,
        signingReady: null,
        custodyState: null,
        detail: 'identity probe skipped by inject',
      };
    }
    return {
      identityProbed: true,
      publicKeyFingerprint: r.publicKeyFingerprint,
      walletAddressRaw: r.walletAddressRaw,
      signingReady: r.signingReady,
      custodyState: r.custodyState,
      detail: null,
    };
  }
  if (
    baseUrl === null ||
    baseUrl.trim() === '' ||
    serviceToken === null ||
    serviceToken === undefined ||
    serviceToken.trim().length < 32
  ) {
    return {
      identityProbed: false,
      publicKeyFingerprint: null,
      walletAddressRaw: null,
      signingReady: null,
      custodyState: null,
      detail: 'signer identity probe skipped (token not configured)',
    };
  }
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/signing-identity`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${serviceToken}`,
      },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      return {
        identityProbed: false,
        publicKeyFingerprint: null,
        walletAddressRaw: null,
        signingReady: null,
        custodyState: null,
        detail: `signer identity HTTP ${response.status}`,
      };
    }
    return {
      identityProbed: true,
      publicKeyFingerprint:
        typeof body.publicKeyFingerprint === 'string' ? body.publicKeyFingerprint : null,
      walletAddressRaw: typeof body.walletAddressRaw === 'string' ? body.walletAddressRaw : null,
      signingReady: body.signingReady === true,
      custodyState: typeof body.custodyState === 'string' ? body.custodyState : null,
      detail: null,
    };
  } catch (error) {
    return {
      identityProbed: false,
      publicKeyFingerprint: null,
      walletAddressRaw: null,
      signingReady: null,
      custodyState: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Perform authoritative read-only live probes. Never unlocks/signs/broadcasts.
 */
export async function runPhase10LiveExternalProbes(
  input: Phase10LiveExternalProbeInput,
): Promise<Phase10LiveExternalProbeEvidence> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const observedAt = new Date().toISOString();
  const blockers: string[] = [];

  const independence = evaluateProviderIndependence({
    primaryKind: input.primary.kind,
    secondaryKind: input.secondary.kind,
    primaryUrl: input.primary.baseUrl,
    secondaryUrl: input.secondary.baseUrl,
  });
  if (!independence.proven) {
    blockers.push(
      `${PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN}: ${independence.reason ?? 'independence unproven'}`,
    );
  }

  const [primary, secondary] = await Promise.all([
    probeOneProvider('primary', input.primary, input.inject?.primaryHealth),
    probeOneProvider('secondary', input.secondary, input.inject?.secondaryHealth),
  ]);

  if (!primary.healthy) {
    blockers.push(
      `PRIMARY_PROVIDER_UNHEALTHY: ${primary.detail ?? 'primary provider not healthy'}`,
    );
  }
  if (!secondary.healthy) {
    blockers.push(
      `SECONDARY_PROVIDER_UNHEALTHY: ${secondary.detail ?? 'secondary provider not healthy'}`,
    );
  }

  const ready = await probeSignerReady(input.signerBaseUrl, fetchImpl, input.inject);
  const identity = await probeSignerIdentity(
    input.signerBaseUrl,
    input.signerServiceToken,
    fetchImpl,
    input.inject,
  );

  let identityMatchesExpected: boolean | null = null;
  if (
    identity.identityProbed &&
    input.expectedPublicKeyFingerprint !== undefined &&
    input.expectedPublicKeyFingerprint !== null &&
    input.expectedPublicKeyFingerprint.trim() !== ''
  ) {
    identityMatchesExpected =
      (identity.publicKeyFingerprint ?? '').toLowerCase() ===
      input.expectedPublicKeyFingerprint.trim().toLowerCase();
    if (!identityMatchesExpected) {
      blockers.push('SIGNER_IDENTITY_MISMATCH: probed fingerprint does not match expected');
    }
  }

  const signingReady =
    ready.signingReady === true || (identity.identityProbed && identity.signingReady === true);
  const custodyState = ready.custodyState ?? identity.custodyState;
  const unlocked =
    signingReady &&
    (custodyState === null || custodyState.toUpperCase() === 'UNLOCKED' || custodyState === 'n/a');

  if (!ready.reachable && !identity.identityProbed) {
    blockers.push('SIGNER_PROBE_FAILED: signer health/identity probe did not succeed');
  } else if (!unlocked) {
    blockers.push(
      `SIGNER_NOT_READY: custodyState=${custodyState ?? 'unknown'} signingReady=${signingReady}`,
    );
  }

  const signer: Phase10SignerProbeObservation = {
    probePerformed: ready.reachable || identity.identityProbed,
    healthReachable: ready.reachable,
    custodyState,
    signingReady: unlocked,
    expectedCustodyMode: input.expectedCustodyMode?.trim() || null,
    identityProbed: identity.identityProbed,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    walletAddressRaw: identity.walletAddressRaw,
    identityMatchesExpected,
    httpStatus: ready.httpStatus,
    detail: ready.detail ?? identity.detail,
    observedAt: new Date().toISOString(),
  };

  return {
    schemaVersion: 1,
    observedAt,
    primary,
    secondary,
    providerIndependence: independence,
    signer,
    overallBlocked: blockers.length > 0,
    blockers,
  };
}

/** Derive readiness signerLocked from authoritative probe (null = not probed). */
export function signerLockedFromProbe(
  probe: Phase10LiveExternalProbeEvidence | null | undefined,
): boolean | null {
  if (probe === null || probe === undefined) return null;
  if (!probe.signer.probePerformed) return null;
  return !probe.signer.signingReady;
}
