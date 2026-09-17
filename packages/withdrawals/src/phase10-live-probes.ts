/**
 * Read-only Phase 10 live external probes (providers + Signer).
 * Never signs, unlocks, broadcasts, or returns secrets/API keys/tokens.
 */

import { admitWalletSeqno, createTonChainProvider, type TonProviderKind } from '@alex-rewards/ton';

export const PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN = 'PROVIDER_INDEPENDENCE_UNPROVEN' as const;
export const PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID = -3 as const;
export const PHASE10_TON_MAINNET_NETWORK_GLOBAL_ID = -239 as const;
export const PRIMARY_PROVIDER_WRONG_NETWORK = 'PRIMARY_PROVIDER_WRONG_NETWORK' as const;
export const SECONDARY_PROVIDER_WRONG_NETWORK = 'SECONDARY_PROVIDER_WRONG_NETWORK' as const;

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
  readonly walletAddressMatchesExpected: boolean | null;
  readonly expectedPublicKeyFingerprintPresent: boolean;
  readonly expectedWalletAddressPresent: boolean;
  readonly httpStatus: number | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

export interface Phase10WalletSeqnoAdmissionObservation {
  readonly probePerformed: boolean;
  /** True only when admitWalletSeqno returned ok against live/injected providers. */
  readonly admitted: boolean;
  readonly seqno: number | null;
  readonly accountStatus: string | null;
  readonly requiresStateInit: boolean | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly hotWalletAddress: string | null;
  readonly networkGlobalId: number | null;
  readonly publicKeyFingerprint: string | null;
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
  /**
   * Fail-closed Hot Wallet account-state + seqno admission.
   * Caller-supplied booleans cannot impersonate this evidence — only probePerformed
   * observations produced by runPhase10LiveExternalProbes are authoritative.
   */
  readonly walletSeqnoAdmission: Phase10WalletSeqnoAdmissionObservation;
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
  /**
   * Authoritative expected public-key fingerprint from DB Hot Wallet / reviewed config.
   * Required for controlled live preflight eligibility.
   */
  readonly expectedPublicKeyFingerprint?: string | null;
  /**
   * Authoritative expected Hot Wallet raw address from DB.
   * Required for controlled live preflight eligibility.
   */
  readonly expectedWalletAddressRaw?: string | null;
  /**
   * Approved Hot Wallet signer_reference (public-key fingerprint) for seqno admission.
   * Must match expectedPublicKeyFingerprint when both are present.
   */
  readonly approvedSignerKeyReference?: string | null;
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
      publicKeyHex: string;
      publicKeyFingerprint: string;
      walletAddressRaw: string;
      signingReady: boolean;
      custodyState: string;
    } | null>;
    /**
     * Full admission observation only — a bare boolean cannot satisfy preflight.
     * Tests inject the observation returned by admitWalletSeqno against fakes.
     */
    readonly walletSeqnoAdmission?: () => Promise<Phase10WalletSeqnoAdmissionObservation>;
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

function networkBlockerForProvider(
  label: 'PRIMARY' | 'SECONDARY',
  observation: Phase10ProviderProbeObservation,
): string | null {
  const code =
    label === 'PRIMARY' ? PRIMARY_PROVIDER_WRONG_NETWORK : SECONDARY_PROVIDER_WRONG_NETWORK;
  const networkId = observation.observedNetworkGlobalId;
  if (!observation.healthy) {
    return null; // unhealthy handled separately
  }
  if (networkId === null || networkId === undefined || !Number.isFinite(networkId)) {
    return `${code}: observed network unknown/null (TON Testnet -3 required)`;
  }
  if (networkId === PHASE10_TON_MAINNET_NETWORK_GLOBAL_ID) {
    return `${code}: observed Mainnet networkGlobalId=-239 (forbidden)`;
  }
  if (networkId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
    return `${code}: observed networkGlobalId=${networkId} (TON Testnet -3 required)`;
  }
  return null;
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
  publicKeyHex: string | null;
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
        publicKeyHex: null,
        publicKeyFingerprint: null,
        walletAddressRaw: null,
        signingReady: null,
        custodyState: null,
        detail: 'identity probe skipped by inject',
      };
    }
    return {
      identityProbed: true,
      publicKeyHex: r.publicKeyHex,
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
      publicKeyHex: null,
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
        publicKeyHex: null,
        publicKeyFingerprint: null,
        walletAddressRaw: null,
        signingReady: null,
        custodyState: null,
        detail: `signer identity HTTP ${response.status}`,
      };
    }
    const publicKeyHex =
      typeof body.publicKeyHex === 'string' && /^[0-9a-fA-F]{64}$/.test(body.publicKeyHex)
        ? body.publicKeyHex.toLowerCase()
        : null;
    return {
      identityProbed: true,
      publicKeyHex,
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
      publicKeyHex: null,
      publicKeyFingerprint: null,
      walletAddressRaw: null,
      signingReady: null,
      custodyState: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeHexFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '');
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Perform authoritative read-only live probes. Never unlocks/signs/broadcasts.
 * Controlled live Phase 10 requires exact Testnet (-3) on both providers and
 * Signer custodyState === UNLOCKED with identity bound to authoritative Hot Wallet.
 * local_ephemeral (custodyState n/a) never qualifies.
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
  } else {
    const primaryNetworkBlocker = networkBlockerForProvider('PRIMARY', primary);
    if (primaryNetworkBlocker !== null) blockers.push(primaryNetworkBlocker);
  }
  if (!secondary.healthy) {
    blockers.push(
      `SECONDARY_PROVIDER_UNHEALTHY: ${secondary.detail ?? 'secondary provider not healthy'}`,
    );
  } else {
    const secondaryNetworkBlocker = networkBlockerForProvider('SECONDARY', secondary);
    if (secondaryNetworkBlocker !== null) blockers.push(secondaryNetworkBlocker);
  }

  const ready = await probeSignerReady(input.signerBaseUrl, fetchImpl, input.inject);
  const identity = await probeSignerIdentity(
    input.signerBaseUrl,
    input.signerServiceToken,
    fetchImpl,
    input.inject,
  );

  const expectedFingerprint =
    input.expectedPublicKeyFingerprint !== undefined &&
    input.expectedPublicKeyFingerprint !== null &&
    input.expectedPublicKeyFingerprint.trim() !== ''
      ? normalizeHexFingerprint(input.expectedPublicKeyFingerprint)
      : null;
  const expectedWallet =
    input.expectedWalletAddressRaw !== undefined &&
    input.expectedWalletAddressRaw !== null &&
    input.expectedWalletAddressRaw.trim() !== ''
      ? normalizeAddress(input.expectedWalletAddressRaw)
      : null;

  let identityMatchesExpected: boolean | null = null;
  let walletAddressMatchesExpected: boolean | null = null;

  if (!ready.reachable) {
    blockers.push('SIGNER_PROBE_FAILED: signer health probe did not succeed');
  }
  if (!identity.identityProbed) {
    blockers.push('SIGNER_IDENTITY_NOT_PROBED: signer identity probe required for live preflight');
  }
  if (expectedFingerprint === null) {
    blockers.push(
      'SIGNER_EXPECTED_FINGERPRINT_MISSING: authoritative Hot Wallet signer reference required',
    );
  }
  if (expectedWallet === null) {
    blockers.push('SIGNER_EXPECTED_WALLET_MISSING: authoritative Hot Wallet raw address required');
  }

  if (identity.identityProbed && expectedFingerprint !== null) {
    const observed = identity.publicKeyFingerprint
      ? normalizeHexFingerprint(identity.publicKeyFingerprint)
      : null;
    identityMatchesExpected = observed !== null && observed === expectedFingerprint;
    if (!identityMatchesExpected) {
      blockers.push('SIGNER_IDENTITY_MISMATCH: probed fingerprint does not match expected');
    }
  }
  if (identity.identityProbed && expectedWallet !== null) {
    const observed = identity.walletAddressRaw ? normalizeAddress(identity.walletAddressRaw) : null;
    walletAddressMatchesExpected = observed !== null && observed === expectedWallet;
    if (!walletAddressMatchesExpected) {
      blockers.push(
        'SIGNER_WALLET_ADDRESS_MISMATCH: probed wallet address does not match authoritative Hot Wallet',
      );
    }
  }

  const signingReadyObserved =
    ready.signingReady === true || (identity.identityProbed && identity.signingReady === true);
  const custodyState = ready.custodyState ?? identity.custodyState;
  // Exact UNLOCKED only — null / n/a (local_ephemeral) never qualify for controlled live.
  const custodyUnlocked = custodyState !== null && custodyState.toUpperCase() === 'UNLOCKED';
  const unlocked =
    ready.reachable &&
    identity.identityProbed &&
    signingReadyObserved &&
    custodyUnlocked &&
    identityMatchesExpected === true &&
    walletAddressMatchesExpected === true &&
    expectedFingerprint !== null &&
    expectedWallet !== null;

  if (ready.reachable && identity.identityProbed && !custodyUnlocked) {
    blockers.push(
      `SIGNER_CUSTODY_NOT_UNLOCKED: custodyState=${custodyState ?? 'null'} (UNLOCKED required; local_ephemeral/n/a never qualifies)`,
    );
  } else if (ready.reachable && identity.identityProbed && !signingReadyObserved) {
    blockers.push(
      `SIGNER_NOT_READY: custodyState=${custodyState ?? 'unknown'} signingReady=${signingReadyObserved}`,
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
    walletAddressMatchesExpected,
    expectedPublicKeyFingerprintPresent: expectedFingerprint !== null,
    expectedWalletAddressPresent: expectedWallet !== null,
    httpStatus: ready.httpStatus,
    detail: ready.detail ?? identity.detail,
    observedAt: new Date().toISOString(),
  };

  const walletSeqnoAdmission = await probeWalletSeqnoAdmission(input, identity, expectedWallet);
  if (!walletSeqnoAdmission.probePerformed) {
    blockers.push('WALLET_SEQNO_ADMISSION_PROBE_REQUIRED');
  } else if (!walletSeqnoAdmission.admitted) {
    blockers.push(
      `WALLET_SEQNO_ADMISSION_BLOCKED:${walletSeqnoAdmission.code ?? 'unknown'}:${walletSeqnoAdmission.message ?? 'not admitted'}`,
    );
  }

  return {
    schemaVersion: 1,
    observedAt,
    primary,
    secondary,
    providerIndependence: independence,
    signer,
    walletSeqnoAdmission,
    overallBlocked: blockers.length > 0 || !walletSeqnoAdmission.admitted,
    blockers,
  };
}

async function probeWalletSeqnoAdmission(
  input: Phase10LiveExternalProbeInput,
  identity: {
    readonly identityProbed: boolean;
    readonly publicKeyHex: string | null;
    readonly publicKeyFingerprint: string | null;
  },
  expectedWallet: string | null,
): Promise<Phase10WalletSeqnoAdmissionObservation> {
  const observedAt = new Date().toISOString();
  if (input.inject?.walletSeqnoAdmission !== undefined) {
    const injected = await input.inject.walletSeqnoAdmission();
    // Reject bare success without probePerformed — fail-closed against impersonation.
    if (injected.probePerformed !== true) {
      return {
        probePerformed: false,
        admitted: false,
        seqno: null,
        accountStatus: null,
        requiresStateInit: null,
        code: 'INJECT_INVALID',
        message: 'injected walletSeqnoAdmission must set probePerformed=true',
        hotWalletAddress: expectedWallet,
        networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
        publicKeyFingerprint: identity.publicKeyFingerprint,
        observedAt,
      };
    }
    return { ...injected, observedAt };
  }

  const approvedRef =
    (input.approvedSignerKeyReference ?? input.expectedPublicKeyFingerprint)?.trim() || null;
  if (
    !identity.identityProbed ||
    identity.publicKeyHex === null ||
    identity.publicKeyFingerprint === null ||
    expectedWallet === null ||
    approvedRef === null
  ) {
    return {
      probePerformed: false,
      admitted: false,
      seqno: null,
      accountStatus: null,
      requiresStateInit: null,
      code: 'IDENTITY_INCOMPLETE',
      message: 'Hot Wallet identity + public key required for seqno admission probe',
      hotWalletAddress: expectedWallet,
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      observedAt,
    };
  }

  const primaryKind = input.primary.kind?.trim().toLowerCase() || null;
  const secondaryKind = input.secondary.kind?.trim().toLowerCase() || null;
  if (
    (primaryKind !== 'toncenter' && primaryKind !== 'tonapi') ||
    (secondaryKind !== 'toncenter' && secondaryKind !== 'tonapi') ||
    input.primary.baseUrl === null ||
    input.secondary.baseUrl === null
  ) {
    return {
      probePerformed: false,
      admitted: false,
      seqno: null,
      accountStatus: null,
      requiresStateInit: null,
      code: 'PROVIDERS_INCOMPLETE',
      message: 'dual Testnet providers required for seqno admission probe',
      hotWalletAddress: expectedWallet,
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      observedAt,
    };
  }

  try {
    const primary = createTonChainProvider({
      kind: primaryKind,
      baseUrl: input.primary.baseUrl,
      apiKey: input.primary.apiKey ?? null,
    });
    const secondary = createTonChainProvider({
      kind: secondaryKind,
      baseUrl: input.secondary.baseUrl,
      apiKey: input.secondary.apiKey ?? null,
    });
    const result = await admitWalletSeqno({
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      hotWalletAddress: expectedWallet,
      publicKeyHex: identity.publicKeyHex,
      signerKeyReference: identity.publicKeyFingerprint,
      approvedSignerKeyReference: approvedRef,
      primary,
      secondary,
    });
    if (result.ok) {
      return {
        probePerformed: true,
        admitted: true,
        seqno: result.seqno,
        accountStatus: result.accountStatus,
        requiresStateInit: result.requiresStateInit,
        code: null,
        message: null,
        hotWalletAddress: expectedWallet,
        networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
        publicKeyFingerprint: result.publicKeyFingerprint,
        observedAt,
      };
    }
    return {
      probePerformed: true,
      admitted: false,
      seqno: null,
      accountStatus: result.primary?.status ?? result.secondary?.status ?? null,
      requiresStateInit: null,
      code: result.code,
      message: result.message,
      hotWalletAddress: expectedWallet,
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      observedAt,
    };
  } catch (error) {
    return {
      probePerformed: true,
      admitted: false,
      seqno: null,
      accountStatus: null,
      requiresStateInit: null,
      code: 'PROVIDER_ERROR',
      message: error instanceof Error ? error.message : String(error),
      hotWalletAddress: expectedWallet,
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      observedAt,
    };
  }
}

/** Derive readiness signerLocked from authoritative probe (null = not probed). */
export function signerLockedFromProbe(
  probe: Phase10LiveExternalProbeEvidence | null | undefined,
): boolean | null {
  if (probe === null || probe === undefined) return null;
  if (!probe.signer.probePerformed) return null;
  return !probe.signer.signingReady;
}
