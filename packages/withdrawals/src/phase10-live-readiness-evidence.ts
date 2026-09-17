/**
 * Canonical live preflight evidence artifact consumed by
 * evaluatePhase10AcceptanceFromEvidence / parseLiveReadinessEvidence.
 * Never embeds secrets, API keys, or Signer tokens.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Phase10LiveExternalProbeEvidence } from './phase10-live-probes.js';
import type { Phase10PreflightReport } from './phase10-preflight.js';
import type { Phase10ReadinessConfig } from './phase10-readiness.js';

export const PHASE10_LIVE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION = 2 as const;

export interface Phase10LivePreflightEvidenceArtifact {
  readonly schemaVersion: typeof PHASE10_LIVE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION;
  readonly recordedAt: string;
  readonly liveAuthorizationWindow: boolean;
  readonly verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET' | 'BLOCKED';
  readonly controlledUserId: string | null;
  readonly networkCode: string;
  readonly assetSymbol: string;
  readonly realChainEnabled: boolean;
  readonly fakeChainEnabled: boolean;
  readonly signerProbed: boolean;
  readonly signerReady: boolean;
  readonly signerUnlocked: boolean;
  readonly signerLockState: string | null;
  readonly signerCustodyState: string | null;
  readonly providers: {
    readonly primary: {
      readonly kind: string | null;
      readonly endpointFingerprint: string | null;
      readonly healthy: boolean;
      readonly observedNetworkGlobalId: number | null;
    };
    readonly secondary: {
      readonly kind: string | null;
      readonly endpointFingerprint: string | null;
      readonly healthy: boolean;
      readonly observedNetworkGlobalId: number | null;
    };
    readonly independenceProven: boolean;
    readonly independenceCode: string | null;
  };
  readonly externalProbes: Phase10LiveExternalProbeEvidence | null;
  readonly walletSeqnoAdmission: {
    readonly probePerformed: boolean;
    readonly admitted: boolean;
    readonly seqno: number | null;
    readonly accountStatus: string | null;
    readonly code: string | null;
  } | null;
  readonly preflightBlockers: readonly string[];
  readonly preflightWarnings: readonly string[];
  readonly restoreScanSummary: {
    readonly dangerousCount: number;
    readonly warnCount: number;
    readonly scannedAt: string;
    readonly historicalIsolatedBaselineCount: number;
  };
  readonly historicalBaselineReference: {
    readonly attemptIds: readonly string[];
    readonly capturedAt: string | null;
  } | null;
  /** Nested aliases for parsers that look under preflight/readiness. */
  readonly preflight: {
    readonly verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET' | 'BLOCKED';
    readonly liveAuthorizationWindow: boolean;
    readonly realChainEnabled: boolean;
    readonly fakeChainEnabled: boolean;
    readonly networkCode: string;
    readonly assetSymbol: string;
    readonly controlledUserId: string | null;
    readonly recordedAt: string;
    readonly signerProbed: boolean;
    readonly signerReady: boolean;
    readonly signerUnlocked: boolean;
    readonly signerLockState: string | null;
  };
}

export interface BuildPhase10LivePreflightEvidenceInput {
  readonly preflight: Phase10PreflightReport;
  readonly readinessConfig: Phase10ReadinessConfig;
  readonly externalProbes: Phase10LiveExternalProbeEvidence | null;
  /** Owner-authorized live window flag — never auto-true. */
  readonly liveAuthorizationWindow: boolean;
  readonly historicalBaselineReference?: {
    readonly attemptIds: readonly string[];
    readonly capturedAt?: string | null;
  } | null;
  readonly recordedAt?: string;
}

export function buildPhase10LivePreflightEvidence(
  input: BuildPhase10LivePreflightEvidenceInput,
): Phase10LivePreflightEvidenceArtifact {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const controlledUserId = input.readinessConfig.controlledUserId?.trim() || null;
  const networkCode = input.readinessConfig.acceptedNetworkCode;
  const assetSymbol = input.readinessConfig.usdtSymbol;
  const probes = input.externalProbes;
  const signerProbed = probes?.signer.probePerformed === true;
  const signerReady = probes?.signer.signingReady === true;
  const signerCustodyUnlocked =
    probes?.signer.custodyState !== null &&
    probes?.signer.custodyState !== undefined &&
    probes.signer.custodyState.toUpperCase() === 'UNLOCKED';
  const signerIdentityBound =
    probes?.signer.identityProbed === true &&
    probes.signer.identityMatchesExpected === true &&
    probes.signer.walletAddressMatchesExpected === true;
  const signerLockState =
    probes === null
      ? null
      : signerReady && signerCustodyUnlocked
        ? 'UNLOCKED'
        : (probes.signer.custodyState ?? 'LOCKED');

  const historicalIsolatedBaselineCount = input.preflight.restore.findings.filter(
    (f) =>
      f.details !== undefined &&
      (f.details as { historicalIsolatedBaseline?: unknown }).historicalIsolatedBaseline === true,
  ).length;

  const providersOk =
    probes?.primary.healthy === true &&
    probes.secondary.healthy === true &&
    probes.primary.observedNetworkGlobalId === -3 &&
    probes.secondary.observedNetworkGlobalId === -3 &&
    probes.providerIndependence.proven === true;
  const seqnoAdmitted =
    probes?.walletSeqnoAdmission.probePerformed === true &&
    probes.walletSeqnoAdmission.admitted === true;

  const verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET' | 'BLOCKED' =
    input.liveAuthorizationWindow === true &&
    input.preflight.verdict === 'READY_FOR_CONTROLLED_LIVE_TESTNET' &&
    input.preflight.blockers.length === 0 &&
    input.preflight.restore.dangerousCount === 0 &&
    signerProbed &&
    signerReady &&
    signerCustodyUnlocked &&
    signerIdentityBound &&
    providersOk &&
    seqnoAdmitted
      ? 'READY_FOR_CONTROLLED_LIVE_TESTNET'
      : 'BLOCKED';

  const preflightNested: Phase10LivePreflightEvidenceArtifact['preflight'] = {
    verdict,
    liveAuthorizationWindow: input.liveAuthorizationWindow === true,
    realChainEnabled: input.readinessConfig.realChainEnabled === true,
    fakeChainEnabled: input.readinessConfig.fakeChainEnabled === true,
    networkCode,
    assetSymbol,
    controlledUserId,
    recordedAt,
    signerProbed,
    signerReady,
    signerUnlocked: signerReady,
    signerLockState,
  };

  return {
    schemaVersion: PHASE10_LIVE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION,
    recordedAt,
    liveAuthorizationWindow: input.liveAuthorizationWindow === true,
    verdict,
    controlledUserId,
    networkCode,
    assetSymbol,
    realChainEnabled: input.readinessConfig.realChainEnabled === true,
    fakeChainEnabled: input.readinessConfig.fakeChainEnabled === true,
    signerProbed,
    signerReady,
    signerUnlocked: signerReady,
    signerLockState,
    signerCustodyState: probes?.signer.custodyState ?? null,
    providers: {
      primary: {
        kind: probes?.primary.kind ?? null,
        endpointFingerprint: probes?.primary.endpointFingerprint ?? null,
        healthy: probes?.primary.healthy === true,
        observedNetworkGlobalId: probes?.primary.observedNetworkGlobalId ?? null,
      },
      secondary: {
        kind: probes?.secondary.kind ?? null,
        endpointFingerprint: probes?.secondary.endpointFingerprint ?? null,
        healthy: probes?.secondary.healthy === true,
        observedNetworkGlobalId: probes?.secondary.observedNetworkGlobalId ?? null,
      },
      independenceProven: probes?.providerIndependence.proven === true,
      independenceCode: probes?.providerIndependence.code ?? null,
    },
    externalProbes: probes,
    walletSeqnoAdmission:
      probes === null
        ? null
        : {
            probePerformed: probes.walletSeqnoAdmission.probePerformed,
            admitted: probes.walletSeqnoAdmission.admitted,
            seqno: probes.walletSeqnoAdmission.seqno,
            accountStatus: probes.walletSeqnoAdmission.accountStatus,
            code: probes.walletSeqnoAdmission.code,
          },
    preflightBlockers: [...input.preflight.blockers, ...(probes?.blockers ?? [])],
    preflightWarnings: [...input.preflight.warnings],
    restoreScanSummary: {
      dangerousCount: input.preflight.restore.dangerousCount,
      warnCount: input.preflight.restore.warnCount,
      scannedAt: input.preflight.restore.scannedAt,
      historicalIsolatedBaselineCount,
    },
    historicalBaselineReference:
      input.historicalBaselineReference === undefined || input.historicalBaselineReference === null
        ? null
        : {
            attemptIds: [...input.historicalBaselineReference.attemptIds],
            capturedAt: input.historicalBaselineReference.capturedAt ?? null,
          },
    preflight: preflightNested,
  };
}

export async function writePhase10LivePreflightEvidence(
  path: string,
  input: BuildPhase10LivePreflightEvidenceInput,
): Promise<Phase10LivePreflightEvidenceArtifact> {
  const artifact = buildPhase10LivePreflightEvidence(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}
