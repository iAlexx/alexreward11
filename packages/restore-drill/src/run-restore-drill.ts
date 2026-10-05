/**
 * Phase 18 restore-drill orchestrator.
 * DB_ONLY_STEP2A: DB read-only evidence; fullRestoreGatePass always false.
 * FULL_STEP2B: fail-closed Temporal + chain + source-count gate (still no resume).
 * NEVER mutates DB, NEVER resumes payout, NEVER calls signer / ton broadcast / Temporal mutation.
 */

import { checkLedgerInvariants } from '@alex-rewards/ledger';
import { runPhase10RestoreReconcileScan } from '@alex-rewards/withdrawals';
import type { Pool } from 'pg';

import { reconcileChainReadOnly } from './chain-reconciliation.js';
import { captureRepresentativeCounts, diffCountCaptures } from './counts.js';
import { reconcileOutboxReadOnly } from './outbox.js';
import { verifyPayoutDispatchPaused } from './payout-pause.js';
import {
  assertSessionReadOnlyEnforced,
  createRestoreDrillReadOnlyPool,
} from './pool-ro.js';
import { validateRestoredSchema } from './schema.js';
import {
  compareSourceRestoredCounts,
  loadSourceCountCaptureFromPath,
  parseSourceCountCapture,
  SourceCountArtifactError,
} from './source-count-artifact.js';
import {
  assertConnectedRestoreTarget,
  assertRestoreTargetEnv,
  parseRestoreDrillEnv,
  RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED,
  type RestoreDrillEnvConfig,
} from './target-guard.js';
import {
  createTemporalListPort,
  reconcileTemporalWorkflows,
  type TemporalListPort,
} from './temporal-reconciliation.js';
import type {
  CountCapture,
  DrillSectionStatus,
  RestoreDrillReport,
  TimingEvidence,
} from './types.js';
import { enumerateRestoredUserIds, verifySelectedUserHistory } from './user-history.js';
import { summarizeWithdrawalRecords } from './withdrawal-records.js';

export interface RunRestoreDrillOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injected pool for unit tests — still subject to connected target checks. */
  readonly pool?: Pool;
  readonly now?: Date;
  readonly mode?: 'DB_ONLY_STEP2A' | 'FULL_STEP2B';
  readonly timingOverrides?: Partial<TimingEvidence>;
  /** Test injection only — production path uses checkLedgerInvariants. */
  readonly checkLedger?: (
    pool: Pool,
  ) => Promise<{
    readonly ok: boolean;
    readonly findings: ReadonlyArray<{ readonly code: string; readonly severity: string }>;
  }>;
  /** Test injection only — production path uses runPhase10RestoreReconcileScan. */
  readonly restoreReconcile?: (
    pool: Pool,
  ) => Promise<{
    readonly dangerousCount: number;
    readonly warnCount: number;
    readonly byCategory: Readonly<Record<string, number>>;
    readonly autoResend: false;
    readonly autoUnpause: false;
  }>;
  /** Test injection — Temporal visibility list port (FULL_STEP2B). */
  readonly temporalListPort?: TemporalListPort | null;
  /** Test injection — skip filesystem read; supply parsed source capture. */
  readonly sourceCountCapture?: CountCapture | unknown;
  /** Test injection — chain validate override forwarded to reconcileChainReadOnly. */
  readonly chainValidateOverride?: Parameters<
    typeof reconcileChainReadOnly
  >[0]['validateOverride'];
}

/** RPO = how far restored authoritative data lags behind source evidence (seconds). */
export function computeObservedRpoSeconds(
  sourceEvidenceCapturedAt: string | null,
  restoredLatestAuthoritativeTimestamp: string | null,
): number | null {
  if (sourceEvidenceCapturedAt === null || restoredLatestAuthoritativeTimestamp === null) {
    return null;
  }
  const sourceMs = Date.parse(sourceEvidenceCapturedAt);
  const restoredMs = Date.parse(restoredLatestAuthoritativeTimestamp);
  if (!Number.isFinite(sourceMs) || !Number.isFinite(restoredMs)) return null;
  return Math.max(0, Math.round((sourceMs - restoredMs) / 1000));
}

function secondsBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function isBlockingStatus(status: DrillSectionStatus): boolean {
  return (
    status === 'FAIL' ||
    status === 'OWNER_REVIEW_REQUIRED' ||
    status === 'NOT_OBSERVED' ||
    status === 'NOT_EXECUTED'
  );
}

export function computeFullRestoreGatePass(sections: {
  readonly targetIsolationPass: boolean;
  readonly databaseReadOnlyEnforced: boolean;
  readonly schema: DrillSectionStatus;
  readonly pause: DrillSectionStatus;
  readonly pauseEnabled: boolean | null;
  readonly ledger: DrillSectionStatus;
  readonly withdrawalRestore: DrillSectionStatus;
  readonly outbox: DrillSectionStatus;
  readonly countComparison: DrillSectionStatus;
  readonly selectedUser: DrillSectionStatus;
  readonly workflow: DrillSectionStatus;
  readonly blockchain: DrillSectionStatus;
  readonly withdrawalRecords: DrillSectionStatus;
}): boolean {
  if (!sections.targetIsolationPass) return false;
  if (!sections.databaseReadOnlyEnforced) return false;
  if (sections.pauseEnabled !== true) return false;
  const mandatory: DrillSectionStatus[] = [
    sections.schema,
    sections.pause,
    sections.ledger,
    sections.withdrawalRestore,
    sections.outbox,
    sections.countComparison,
    sections.selectedUser,
    sections.workflow,
    sections.blockchain,
    sections.withdrawalRecords,
  ];
  return mandatory.every((s) => s === 'PASS');
}

export async function runRestoreDrill(
  options: RunRestoreDrillOptions = {},
): Promise<RestoreDrillReport> {
  const env = options.env ?? process.env;
  const config = parseRestoreDrillEnv(env);
  const mode = options.mode ?? config.drillMode;
  const bound = assertRestoreTargetEnv(config, { mode });
  const validationStartedAt = (options.now ?? new Date()).toISOString();

  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createRestoreDrillReadOnlyPool(bound.restoreDatabaseUrl);

  let temporalCloseable: { close: () => Promise<void> } | null = null;

  try {
    await assertSessionReadOnlyEnforced(pool);

    const target = await assertConnectedRestoreTarget(pool, bound, {
      databaseReadOnlyEnforced: true,
    });

    const schema = await validateRestoredSchema(pool);
    const pause = await verifyPayoutDispatchPaused(pool, bound.featureFlagEnvironment);

    let ledgerOk: boolean | null = null;
    let ledgerCriticalCount = 0;
    let ledgerFindingCodes: string[] = [];
    let ledgerStatus: RestoreDrillReport['ledgerInvariants']['status'] = 'FAIL';
    let ledgerReason = 'LEDGER_CHECK_FAILED';
    try {
      const checkLedger = options.checkLedger ?? checkLedgerInvariants;
      const ledger = await checkLedger(pool);
      ledgerOk = ledger.ok;
      const critical = ledger.findings.filter((f) => f.severity === 'CRITICAL');
      ledgerCriticalCount = critical.length;
      ledgerFindingCodes = critical.map((f) => f.code);
      if (!ledger.ok || critical.length > 0) {
        ledgerStatus = 'FAIL';
        ledgerReason = 'CRITICAL_LEDGER_INVARIANT';
      } else {
        ledgerStatus = 'PASS';
        ledgerReason = 'LEDGER_INVARIANTS_OK';
      }
    } catch {
      ledgerStatus = 'FAIL';
      ledgerReason = 'LEDGER_CHECK_FAILED';
    }

    let withdrawDanger = 0;
    let withdrawWarn = 0;
    let byCategory: Record<string, number> = {};
    let withdrawStatus: RestoreDrillReport['withdrawalRestoreReconcile']['status'] = 'FAIL';
    let withdrawReason = 'RESTORE_RECONCILE_FAILED';
    try {
      const restoreReconcile = options.restoreReconcile ?? runPhase10RestoreReconcileScan;
      const restore = await restoreReconcile(pool);
      withdrawDanger = restore.dangerousCount;
      withdrawWarn = restore.warnCount;
      byCategory = { ...restore.byCategory };
      if (restore.dangerousCount > 0) {
        withdrawStatus = 'FAIL';
        withdrawReason = 'RESTORE_RECONCILE_DANGER';
      } else if (restore.warnCount > 0) {
        withdrawStatus = 'OWNER_REVIEW_REQUIRED';
        withdrawReason = 'RESTORE_RECONCILE_WARN';
      } else {
        withdrawStatus = 'PASS';
        withdrawReason = 'RESTORE_RECONCILE_CLEAN';
      }
    } catch {
      withdrawStatus = 'FAIL';
      withdrawReason = 'RESTORE_RECONCILE_FAILED';
    }

    const outbox = await reconcileOutboxReadOnly(pool);
    const counts = await captureRepresentativeCounts(pool);

    let verifyUserIds = config.verifyUserIds;
    if (mode === 'FULL_STEP2B' && config.verifyAllUsers) {
      verifyUserIds = [...(await enumerateRestoredUserIds(pool))];
    }
    const userHistory = await verifySelectedUserHistory(pool, verifyUserIds);
    const withdrawalRecords = await summarizeWithdrawalRecords(pool);

    // --- Count comparison (FULL only) ---
    let sourceCapture: CountCapture | null = null;
    let countComparisonStatus: DrillSectionStatus = 'NOT_EXECUTED';
    let countStatus: DrillSectionStatus = counts.status;
    let countDiff: Readonly<Record<string, number>> | null = diffCountCaptures(
      null,
      counts.restoredCapture,
    );
    let countFailedTables: readonly string[] = counts.failedTables;
    let countReasonExtra: string | null = null;

    if (mode === 'FULL_STEP2B') {
      try {
        if (options.sourceCountCapture !== undefined) {
          sourceCapture =
            options.sourceCountCapture !== null &&
            typeof options.sourceCountCapture === 'object' &&
            'tables' in (options.sourceCountCapture as object) &&
            'capturedAt' in (options.sourceCountCapture as object) &&
            typeof (options.sourceCountCapture as CountCapture).capturedAt === 'string' &&
            typeof (options.sourceCountCapture as CountCapture).tables === 'object'
              ? (options.sourceCountCapture as CountCapture)
              : parseSourceCountCapture(options.sourceCountCapture);
        } else if (config.sourceCountCapturePath !== null) {
          sourceCapture = loadSourceCountCaptureFromPath(config.sourceCountCapturePath);
        } else {
          throw new SourceCountArtifactError(
            'SOURCE_COUNT_CAPTURE_MISSING',
            'PHASE18_SOURCE_COUNT_CAPTURE_PATH is required for FULL_STEP2B',
          );
        }

        const restoreTargetAt = config.restoreTargetAt;
        if (restoreTargetAt === null) {
          countStatus = 'FAIL';
          countComparisonStatus = 'FAIL';
          countReasonExtra = 'RESTORE_TARGET_AT_MISSING';
        } else if (new Date(Date.parse(sourceCapture.capturedAt)).toISOString() !== restoreTargetAt) {
          countStatus = 'FAIL';
          countComparisonStatus = 'FAIL';
          countReasonExtra = 'SOURCE_CAPTURE_RESTORE_TARGET_MISMATCH';
        } else if (counts.restoredCapture === null || counts.restoredCaptureStatus === 'FAIL') {
          countStatus = 'FAIL';
          countComparisonStatus = 'FAIL';
          countReasonExtra = 'RESTORED_COUNT_CAPTURE_FAILED';
        } else {
          const compared = compareSourceRestoredCounts(sourceCapture, counts.restoredCapture);
          countDiff = compared.diff;
          countFailedTables = compared.failedTables;
          countComparisonStatus = compared.status;
          countStatus = compared.status === 'PASS' ? counts.status : compared.status;
          countReasonExtra = compared.reasonCode;
        }
      } catch (error: unknown) {
        countStatus = 'FAIL';
        countComparisonStatus = 'FAIL';
        countReasonExtra =
          error instanceof SourceCountArtifactError
            ? error.code
            : 'SOURCE_COUNT_ARTIFACT_FAILED';
        sourceCapture = null;
        countDiff = null;
      }
    }

    const evidenceAlignedForFull =
      mode !== 'FULL_STEP2B' ||
      (countReasonExtra !== 'SOURCE_CAPTURE_RESTORE_TARGET_MISMATCH' &&
        countReasonExtra !== 'RESTORE_TARGET_AT_MISSING' &&
        countReasonExtra !== 'SOURCE_COUNT_ARTIFACT_FAILED' &&
        countReasonExtra !== 'SOURCE_COUNT_CAPTURE_MISSING' &&
        sourceCapture !== null);

    // --- Temporal (FULL only) ---
    let workflowSection: RestoreDrillReport['workflowReconciliation'];
    if (mode === 'FULL_STEP2B' && !evidenceAlignedForFull) {
      workflowSection = {
        status: 'FAIL',
        reasonCode: countReasonExtra ?? 'SOURCE_CAPTURE_RESTORE_TARGET_MISMATCH',
        dbExpectedWorkflowIdentityCount: 0,
        temporalObservedWorkflowCount: 0,
        matchedCount: 0,
        missingInTemporalCount: 0,
        unexpectedInTemporalCount: 0,
        statusCounts: {},
        mismatchReferences: [],
        temporalQueried: false,
      };
    } else if (mode === 'FULL_STEP2B') {
      let temporalPort: TemporalListPort | null = null;
      if (options.temporalListPort !== undefined) {
        temporalPort = options.temporalListPort;
      } else if (config.temporalAddress !== null && config.temporalNamespace !== null) {
        const created = await createTemporalListPort({
          address: config.temporalAddress,
          namespace: config.temporalNamespace,
        });
        temporalCloseable = created;
        temporalPort = created;
      }
      const workflow = await reconcileTemporalWorkflows({ pool, temporal: temporalPort });
      workflowSection = {
        status: workflow.status,
        reasonCode: workflow.reasonCode,
        dbExpectedWorkflowIdentityCount: workflow.dbExpectedWorkflowIdentityCount,
        temporalObservedWorkflowCount: workflow.temporalObservedWorkflowCount,
        matchedCount: workflow.matchedCount,
        missingInTemporalCount: workflow.missingInTemporalCount,
        unexpectedInTemporalCount: workflow.unexpectedInTemporalCount,
        statusCounts: workflow.statusCounts,
        mismatchReferences: workflow.mismatchReferences,
        temporalQueried: workflow.temporalQueried,
      };
    } else {
      workflowSection = {
        status: 'NOT_OBSERVED',
        reasonCode: 'TEMPORAL_NOT_QUERIED_STEP2A',
        dbExpectedWorkflowIdentityCount: 0,
        temporalObservedWorkflowCount: 0,
        matchedCount: 0,
        missingInTemporalCount: 0,
        unexpectedInTemporalCount: 0,
        statusCounts: {},
        mismatchReferences: [],
        temporalQueried: false,
      };
    }

        // --- Chain (FULL only) ---
    let chainSection: RestoreDrillReport['blockchainReconciliation'];
    if (mode === 'FULL_STEP2B' && !evidenceAlignedForFull) {
      chainSection = {
        status: 'FAIL',
        reasonCode: countReasonExtra ?? 'SOURCE_CAPTURE_RESTORE_TARGET_MISMATCH',
        liveChainReconciliation: 'NOT_OBSERVED',
        withdrawalsRequiringLiveChainCount: withdrawalRecords.requiringLiveChainCount,
        liveProviderQueryPerformed: false,
        chainScopeEmpty: false,
        providerQueryPerformed: false,
        primaryHealthy: null,
        secondaryHealthy: null,
        providerAgreement: null,
        windowFullyCovered: null,
        agreedTransferCount: null,
        knownExpectedTransferCount: null,
        confirmedMatchedCount: null,
        unexpectedOutgoingCount: null,
        ambiguousAttemptCount: null,
        providerReportDigest: null,
        payoutInvariantFailCount: null,
        payoutInvariantFindingCodes: [],
        mismatchReferences: [],
        observationWindowStart: null,
        observationWindowEnd: config.restoreTargetAt,
        restoreTargetAt: config.restoreTargetAt,
      };
    } else if (mode === 'FULL_STEP2B') {
      if (config.restoreTargetAt === null) {
        throw new Error('FULL_STEP2B missing restoreTargetAt after env guard');
      }
      const chain = await reconcileChainReadOnly({
        pool,
        env,
        restoreTargetAt: config.restoreTargetAt,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.chainValidateOverride !== undefined
          ? { validateOverride: options.chainValidateOverride }
          : {}),
      });
      chainSection = {
        status: chain.status,
        reasonCode: chain.reasonCode,
        liveChainReconciliation: chain.liveChainReconciliation,
        withdrawalsRequiringLiveChainCount: chain.withdrawalsRequiringLiveChainCount,
        liveProviderQueryPerformed: chain.liveProviderQueryPerformed,
        chainScopeEmpty: chain.chainScopeEmpty,
        providerQueryPerformed: chain.providerQueryPerformed,
        primaryHealthy: chain.primaryHealthy,
        secondaryHealthy: chain.secondaryHealthy,
        providerAgreement: chain.providerAgreement,
        windowFullyCovered: chain.windowFullyCovered,
        agreedTransferCount: chain.agreedTransferCount,
        knownExpectedTransferCount: chain.knownExpectedTransferCount,
        confirmedMatchedCount: chain.confirmedMatchedCount,
        unexpectedOutgoingCount: chain.unexpectedOutgoingCount,
        ambiguousAttemptCount: chain.ambiguousAttemptCount,
        providerReportDigest: chain.providerReportDigest,
        payoutInvariantFailCount: chain.payoutInvariantFailCount,
        payoutInvariantFindingCodes: chain.payoutInvariantFindingCodes,
        mismatchReferences: chain.mismatchReferences,
        observationWindowStart: chain.observationWindowStart,
        observationWindowEnd: chain.observationWindowEnd,
        restoreTargetAt: chain.restoreTargetAt,
      };
    } else {
      chainSection = {
        status: 'NOT_OBSERVED',
        reasonCode: 'LIVE_CHAIN_NOT_QUERIED_STEP2A',
        liveChainReconciliation: 'NOT_OBSERVED',
        withdrawalsRequiringLiveChainCount: withdrawalRecords.requiringLiveChainCount,
        liveProviderQueryPerformed: false,
        chainScopeEmpty: false,
        providerQueryPerformed: false,
        primaryHealthy: null,
        secondaryHealthy: null,
        providerAgreement: null,
        windowFullyCovered: null,
        agreedTransferCount: null,
        knownExpectedTransferCount: null,
        confirmedMatchedCount: null,
        unexpectedOutgoingCount: null,
        ambiguousAttemptCount: null,
        providerReportDigest: null,
        payoutInvariantFailCount: null,
        payoutInvariantFindingCodes: [],
        mismatchReferences: [],
        observationWindowStart: null,
        observationWindowEnd: null,
        restoreTargetAt: null,
      };
    }

    const validationCompletedAt = new Date().toISOString();
    const timing: TimingEvidence = {
      backupCapturedAt: options.timingOverrides?.backupCapturedAt ?? null,
      restoreStartedAt: options.timingOverrides?.restoreStartedAt ?? null,
      restoreAvailableAt: options.timingOverrides?.restoreAvailableAt ?? null,
      validationStartedAt,
      validationCompletedAt,
      observedRestoreSeconds: secondsBetween(
        options.timingOverrides?.restoreStartedAt ?? null,
        options.timingOverrides?.restoreAvailableAt ?? null,
      ),
      observedValidationSeconds: secondsBetween(validationStartedAt, validationCompletedAt),
      observedRtoSeconds: secondsBetween(
        options.timingOverrides?.restoreStartedAt ?? null,
        validationCompletedAt,
      ),
      sourceEvidenceCapturedAt:
        options.timingOverrides?.sourceEvidenceCapturedAt ??
        sourceCapture?.capturedAt ??
        null,
      restoredLatestAuthoritativeTimestamp:
        options.timingOverrides?.restoredLatestAuthoritativeTimestamp ?? null,
      observedRpoSeconds: computeObservedRpoSeconds(
        options.timingOverrides?.sourceEvidenceCapturedAt ??
          sourceCapture?.capturedAt ??
          null,
        options.timingOverrides?.restoredLatestAuthoritativeTimestamp ?? null,
      ),
      rtoTargetSeconds: 'OWNER_POLICY_REQUIRED',
      rpoTargetSeconds: 'OWNER_POLICY_REQUIRED',
    };

    const hardFails = [
      schema.status === 'FAIL',
      pause.status === 'FAIL',
      ledgerStatus === 'FAIL',
      withdrawStatus === 'FAIL' || withdrawStatus === 'OWNER_REVIEW_REQUIRED',
      outbox.status === 'FAIL' || outbox.status === 'OWNER_REVIEW_REQUIRED',
      countStatus === 'FAIL',
      userHistory.status === 'FAIL',
      withdrawalRecords.status === 'FAIL',
    ];
    const restoreValidationPass = !hardFails.some(Boolean);

    const fullRestoreGatePass =
      mode === 'FULL_STEP2B'
        ? computeFullRestoreGatePass({
            targetIsolationPass:
              target.targetDatabaseNameMatchesExpected &&
              (target.targetDistinctFromSource === true ||
                target.targetDistinctFromSource === null),
            databaseReadOnlyEnforced: target.databaseReadOnlyEnforced,
            schema: schema.status,
            pause: pause.status,
            pauseEnabled: pause.payoutDispatchPausedAtValidation,
            ledger: ledgerStatus,
            withdrawalRestore: withdrawStatus,
            outbox: outbox.status,
            countComparison: countComparisonStatus,
            selectedUser: userHistory.status,
            workflow: workflowSection.status,
            blockchain: chainSection.status,
            withdrawalRecords: withdrawalRecords.status,
          })
        : false;

    const notes: string[] = [
      'DATABASE_URL_FALLBACK_ALLOWED=' + String(RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED),
      'Isolation is host/service based; DB name may match source after managed PITR restore.',
      'payoutResumeAllowed=false; resumeDecision=OWNER_APPROVAL_REQUIRED (Owner ceremony required).',
      'autoUnpause=false; autoResend=false; restore-drill never UPDATEs feature_flags.',
    ];
    if (mode === 'DB_ONLY_STEP2A') {
      notes.push(
        'Mode DB_ONLY_STEP2A: Temporal/chain/source-count comparison NOT executed; fullRestoreGatePass=false.',
      );
    } else {
      notes.push(
        'Mode FULL_STEP2B: Temporal visibility, chain scope, and source-count artifact comparison executed read-only.',
      );
      if (chainSection.chainScopeEmpty && !chainSection.providerQueryPerformed) {
        notes.push(
          'Chain zero-scope path: no live provider query performed (NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE).',
        );
      }
      if (countReasonExtra !== null) {
        notes.push(`Source/restored count comparison reason: ${countReasonExtra}`);
      }
    }
    notes.push('Do not enable Railway PITR or create restore resources from this CLI.');

    // Silence unused helper reference under DB_ONLY (still useful for FULL gate callers/tests).
    void isBlockingStatus;

    return {
      contractVersion: 'phase18-restore-drill-v1',
      mode,
      observedAt: validationCompletedAt,
      target,
      timing,
      schema,
      payoutDispatchPause: pause,
      ledgerInvariants: {
        status: ledgerStatus,
        reasonCode: ledgerReason,
        ok: ledgerOk,
        criticalCount: ledgerCriticalCount,
        findingCodes: ledgerFindingCodes,
      },
      withdrawalRestoreReconcile: {
        status: withdrawStatus,
        reasonCode: withdrawReason,
        dangerousCount: withdrawDanger,
        warnCount: withdrawWarn,
        byCategory,
        autoResend: false,
        autoUnpause: false,
        historicalBaseline: 'NOT_SUPPLIED',
      },
      outbox: {
        status: outbox.status,
        reasonCode: outbox.reasonCode,
        pending: outbox.pending,
        processing: outbox.processing,
        dispatched: outbox.dispatched,
        failed: outbox.failed,
        deadLetter: outbox.deadLetter,
        oldestPendingAgeSeconds: outbox.oldestPendingAgeSeconds,
        withdrawalApprovedPending: outbox.withdrawalApprovedPending,
        duplicateDedupeKeyAnomalies: outbox.duplicateDedupeKeyAnomalies,
        lagThreshold: 'THRESHOLD_NOT_CONFIGURED',
      },
      workflowReconciliation: workflowSection,
      blockchainReconciliation: chainSection,
      representativeCounts: {
        status: countStatus,
        restoredCaptureStatus: counts.restoredCaptureStatus,
        comparisonStatus: countComparisonStatus,
        failedTables: countFailedTables,
        sourceCapture,
        restoredCapture: counts.restoredCapture,
        diff: countDiff,
      },
      selectedUserHistory: {
        status: userHistory.status,
        reasonCode: userHistory.reasonCode,
        userCountConfigured: userHistory.userCountConfigured,
        usersVerified: userHistory.usersVerified,
        users: userHistory.users,
      },
      withdrawalRecords: {
        status: withdrawalRecords.status,
        reasonCode: withdrawalRecords.reasonCode,
        byState: withdrawalRecords.byState,
        requiringLiveChainCount: withdrawalRecords.requiringLiveChainCount,
      },
      restoreValidationPass,
      fullRestoreGatePass,
      payoutResumeAllowed: false,
      resumeDecision: 'OWNER_APPROVAL_REQUIRED',
      autoUnpause: false,
      autoResend: false,
      financialAuthority: false,
      notes,
    };
  } finally {
    if (temporalCloseable !== null) {
      try {
        await temporalCloseable.close();
      } catch {
        // ignore close errors
      }
    }
    if (ownsPool) {
      await pool.end();
    }
  }
}

export type { RestoreDrillEnvConfig };