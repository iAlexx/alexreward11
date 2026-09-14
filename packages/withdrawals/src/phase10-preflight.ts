import type { Pool, PoolClient } from 'pg';

import type { Phase10LiveExternalProbeEvidence } from './phase10-live-probes.js';
import {
  runPhase10Readiness,
  type Phase10ReadinessConfig,
  type Phase10ReadinessReport,
} from './phase10-readiness.js';
import {
  runPhase10RestoreReconcileScan,
  type Phase10HistoricalBaselineInput,
  type Phase10RestoreReconcileScanReport,
} from './phase10-restore-reconcile.js';

export type Phase10PreflightVerdict = 'READY_FOR_CONTROLLED_LIVE_TESTNET' | 'BLOCKED';

export interface Phase10PreflightReport {
  readonly verdict: Phase10PreflightVerdict;
  readonly readiness: Phase10ReadinessReport;
  readonly restore: Phase10RestoreReconcileScanReport;
  readonly externalProbes: Phase10LiveExternalProbeEvidence | null;
  readonly intentionallySafeOff: boolean;
  readonly misconfigured: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface Phase10PreflightInput {
  readonly readinessConfig: Phase10ReadinessConfig;
  /** When true, skip restore scan (tests / offline). Default false. */
  readonly skipRestoreScan?: boolean;
  /**
   * Authoritative live external probe evidence. When real chain is enabled,
   * absence of a successful probe blocks READY (caller-injected signerLocked alone is insufficient).
   */
  readonly externalProbes?: Phase10LiveExternalProbeEvidence | null;
  readonly historicalBaseline?: Phase10HistoricalBaselineInput | null;
  readonly baselineIsolatedHistoricalAttemptIds?: readonly string[];
  readonly liveAuthorizationWindowStartedAt?: string | Date | null;
  readonly campaignCreatedAt?: string | Date | null;
}

/**
 * Aggregate readiness + restore scan + external probes into a controlled live
 * Testnet preflight verdict. Distinguishes intentionally-safe-off vs misconfigured.
 * Never mutates.
 */
export async function runPhase10Preflight(
  db: Pool | PoolClient,
  input: Phase10PreflightInput,
): Promise<Phase10PreflightReport> {
  const readiness = await runPhase10Readiness(db, input.readinessConfig);
  const restore =
    input.skipRestoreScan === true
      ? {
          scannedAt: new Date().toISOString(),
          dangerousCount: 0,
          warnCount: 0,
          historicalIsolatedBaselineCount: 0,
          findings: [],
          byCategory: {
            approved_without_workflow: 0,
            workflow_without_db: 0,
            submitted_unknown_need_chain: 0,
            confirmed_without_settlement: 0,
            settlement_state_mismatch: 0,
            pending_outbox_recovery: 0,
            competing_attempt_lineage: 0,
            synthetic_unknown_isolated: 0,
            historical_isolated_baseline: 0,
          },
          autoResend: false as const,
          autoUnpause: false as const,
        }
      : await runPhase10RestoreReconcileScan(db, {
          ...(input.historicalBaseline !== undefined
            ? { historicalBaseline: input.historicalBaseline }
            : {}),
          ...(input.baselineIsolatedHistoricalAttemptIds !== undefined
            ? {
                baselineIsolatedHistoricalAttemptIds: input.baselineIsolatedHistoricalAttemptIds,
              }
            : {}),
          ...(input.liveAuthorizationWindowStartedAt !== undefined
            ? {
                liveAuthorizationWindowStartedAt: input.liveAuthorizationWindowStartedAt,
              }
            : {}),
          ...(input.campaignCreatedAt !== undefined
            ? { campaignCreatedAt: input.campaignCreatedAt }
            : {}),
        });

  const probes = input.externalProbes ?? null;
  const intentionallySafeOff = readiness.items.some(
    (i) => i.classification === 'intentionally_safe_off',
  );
  const misconfigured = readiness.items.some((i) => i.classification === 'misconfigured');

  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const item of readiness.items) {
    if (item.status === 'BLOCKED') {
      blockers.push(`${item.code}: ${item.message}`);
    } else if (item.status === 'WARN') {
      warnings.push(`${item.code}: ${item.message}`);
    }
  }
  if (restore.dangerousCount > 0) {
    blockers.push(`restore scan: ${restore.dangerousCount} DANGER finding(s)`);
  }
  for (const finding of restore.findings) {
    if (finding.severity === 'WARN') {
      warnings.push(`restore:${finding.category}: ${finding.message}`);
    } else if (finding.severity === 'INFO') {
      warnings.push(`restore:${finding.category}: ${finding.message}`);
    }
  }

  if (!input.readinessConfig.realChainEnabled) {
    blockers.push(
      'WITHDRAWAL_REAL_CHAIN_ENABLED is false (intentionally disabled for live Testnet)',
    );
  }
  if (input.readinessConfig.fakeChainEnabled) {
    blockers.push('WITHDRAWAL_FAKE_CHAIN_ENABLED must be false for controlled live Testnet');
  }

  // Fail-closed for live Testnet: never treat locked/unknown signer or missing
  // controlled user as soft WARN when real chain is enabled.
  if (input.readinessConfig.realChainEnabled === true) {
    const controlled = input.readinessConfig.controlledUserId?.trim() || null;
    if (controlled === null) {
      blockers.push('CONTROLLED_USER: controlled user id not provided');
    }

    // Authoritative probes required — caller-injected signerLocked alone is insufficient.
    if (probes === null) {
      blockers.push(
        'EXTERNAL_PROBES_REQUIRED: live preflight requires authoritative provider+signer probes',
      );
    } else {
      if (probes.overallBlocked || probes.blockers.length > 0) {
        for (const b of probes.blockers) blockers.push(`probe:${b}`);
      }
      if (!probes.signer.probePerformed) {
        blockers.push('SIGNER_PROBE_REQUIRED: signer must be probed (not inferred from env)');
      } else if (!probes.signer.signingReady) {
        blockers.push(`SIGNER_NOT_READY: custodyState=${probes.signer.custodyState ?? 'unknown'}`);
      }
      if (!probes.primary.healthy) {
        blockers.push('PRIMARY_PROVIDER_UNHEALTHY');
      }
      if (!probes.secondary.healthy) {
        blockers.push('SECONDARY_PROVIDER_UNHEALTHY');
      }
      if (!probes.providerIndependence.proven) {
        blockers.push(
          `PROVIDER_INDEPENDENCE_UNPROVEN: ${probes.providerIndependence.reason ?? 'unproven'}`,
        );
      }
    }

    // Still refuse if readiness reported locked even when probes somehow omitted.
    if (input.readinessConfig.signerLocked === true) {
      blockers.push('SIGNER_LOCKED: signer reported LOCKED');
    }

    for (const item of readiness.items) {
      if (
        item.status === 'WARN' &&
        (item.code === 'NETWORK' ||
          item.code === 'CONTROLLED_USER' ||
          item.code === 'SIGNER_LOCKED' ||
          item.code === 'HOT_WALLET' ||
          item.code === 'EXTERNAL_RESOURCE')
      ) {
        blockers.push(`${item.code}: ${item.message} (elevated fail-closed for real chain)`);
      }
    }
  }

  const ready =
    blockers.length === 0 &&
    readiness.overall !== 'BLOCKED' &&
    restore.dangerousCount === 0 &&
    input.readinessConfig.realChainEnabled === true &&
    input.readinessConfig.fakeChainEnabled === false &&
    (probes === null
      ? input.readinessConfig.realChainEnabled !== true
      : probes.signer.probePerformed &&
        probes.signer.signingReady &&
        probes.primary.healthy &&
        probes.secondary.healthy &&
        probes.providerIndependence.proven);

  return {
    verdict: ready ? 'READY_FOR_CONTROLLED_LIVE_TESTNET' : 'BLOCKED',
    readiness,
    restore,
    externalProbes: probes,
    intentionallySafeOff,
    misconfigured,
    blockers,
    warnings,
  };
}
