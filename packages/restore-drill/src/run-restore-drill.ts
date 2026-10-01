/**
 * Phase 18 Step 2A — read-only restore drill orchestrator.
 * NEVER mutates DB, NEVER resumes payout, NEVER calls signer/TON/Temporal replay.
 */

import { checkLedgerInvariants } from '@alex-rewards/ledger';
import { runPhase10RestoreReconcileScan } from '@alex-rewards/withdrawals';
import type { Pool } from 'pg';

import { captureRepresentativeCounts, diffCountCaptures } from './counts.js';
import { reconcileOutboxReadOnly } from './outbox.js';
import { verifyPayoutDispatchPaused } from './payout-pause.js';
import {
  assertSessionReadOnlyEnforced,
  createRestoreDrillReadOnlyPool,
} from './pool-ro.js';
import { validateRestoredSchema } from './schema.js';
import {
  assertConnectedRestoreTarget,
  assertRestoreTargetEnv,
  parseRestoreDrillEnv,
  RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED,
  type RestoreDrillEnvConfig,
} from './target-guard.js';
import type { RestoreDrillReport, TimingEvidence, DrillSectionStatus } from './types.js';
import { verifySelectedUserHistory } from './user-history.js';
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

export async function runRestoreDrill(
  options: RunRestoreDrillOptions = {},
): Promise<RestoreDrillReport> {
  const env = options.env ?? process.env;
  const config = parseRestoreDrillEnv(env);
  const mode = options.mode ?? 'DB_ONLY_STEP2A';
  const bound = assertRestoreTargetEnv(config, { mode });
  const validationStartedAt = (options.now ?? new Date()).toISOString();

  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createRestoreDrillReadOnlyPool(bound.restoreDatabaseUrl);

  try {
    // Production-owned pool must prove PostgreSQL read-only. Injected test pools also verify.
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
    const userHistory = await verifySelectedUserHistory(pool, config.verifyUserIds);
    const withdrawalRecords = await summarizeWithdrawalRecords(pool);

    const dbExpectedWorkflowIdentityCount = await countDbExpectedWorkflowIdentities(pool);

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
      sourceEvidenceCapturedAt: options.timingOverrides?.sourceEvidenceCapturedAt ?? null,
      restoredLatestAuthoritativeTimestamp:
        options.timingOverrides?.restoredLatestAuthoritativeTimestamp ?? null,
      observedRpoSeconds: computeObservedRpoSeconds(
        options.timingOverrides?.sourceEvidenceCapturedAt ?? null,
        options.timingOverrides?.restoredLatestAuthoritativeTimestamp ?? null,
      ),
      rtoTargetSeconds: 'OWNER_POLICY_REQUIRED',
      rpoTargetSeconds: 'OWNER_POLICY_REQUIRED',
    };

    const workflowStatus: DrillSectionStatus = 'NOT_OBSERVED';
    const chainStatus: DrillSectionStatus = 'NOT_OBSERVED';
    const liveChainReconciliation = 'NOT_OBSERVED' as const;
    const temporalObserved = 'NOT_OBSERVED' as const;

    const hardFails = [
      schema.status === 'FAIL',
      pause.status === 'FAIL',
      ledgerStatus === 'FAIL',
      withdrawStatus === 'FAIL' || withdrawStatus === 'OWNER_REVIEW_REQUIRED',
      outbox.status === 'FAIL' || outbox.status === 'OWNER_REVIEW_REQUIRED',
      counts.status === 'FAIL',
      userHistory.status === 'FAIL',
      withdrawalRecords.status === 'FAIL',
    ];
    const restoreValidationPass = !hardFails.some(Boolean);

    // Step 2A: Temporal / live chain / source-restored comparison incomplete ⇒ full gate false.
    const fullRestoreGatePass = false;
    const payoutResumeAllowedFinal = false;

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
      workflowReconciliation: {
        status: workflowStatus,
        reasonCode: 'TEMPORAL_NOT_QUERIED_STEP2A',
        dbExpectedWorkflowIdentityCount,
        temporalObserved,
      },
      blockchainReconciliation: {
        status: chainStatus,
        reasonCode: 'LIVE_CHAIN_NOT_QUERIED_STEP2A',
        liveChainReconciliation,
        withdrawalsRequiringLiveChainCount: withdrawalRecords.requiringLiveChainCount,
      },
      representativeCounts: {
        status: counts.status,
        restoredCaptureStatus: counts.restoredCaptureStatus,
        comparisonStatus: counts.comparisonStatus,
        failedTables: counts.failedTables,
        sourceCapture: null,
        restoredCapture: counts.restoredCapture,
        diff: diffCountCaptures(null, counts.restoredCapture),
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
      payoutResumeAllowed: payoutResumeAllowedFinal,
      autoUnpause: false,
      autoResend: false,
      financialAuthority: false,
      notes: [
        'DATABASE_URL_FALLBACK_ALLOWED=' + String(RESTORE_DRILL_DATABASE_URL_FALLBACK_ALLOWED),
        'Isolation is host/service based; DB name may match source after managed PITR restore.',
        'Step 2A is DB-only preparation; fullRestoreGatePass=false (Temporal/chain/count comparison NOT complete).',
        'PAYOUT_RESUME_ALLOWED is false until Step 2B completes all required evidence.',
        'Do not enable Railway PITR or create restore resources from this CLI.',
      ],
    };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

async function countDbExpectedWorkflowIdentities(pool: Pool): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM withdrawals
        WHERE workflow_id IS NOT NULL`,
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export type { RestoreDrillEnvConfig };
