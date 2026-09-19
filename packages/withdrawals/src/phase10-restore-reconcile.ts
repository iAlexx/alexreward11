import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';
import { WITHDRAWAL_APPROVED_OUTBOX_EVENT, withdrawalWorkflowId } from './outbox.js';

export type Phase10RestoreFindingCategory =
  | 'approved_without_workflow'
  | 'workflow_without_db'
  | 'submitted_unknown_need_chain'
  | 'confirmed_without_settlement'
  | 'settlement_state_mismatch'
  | 'pending_outbox_recovery'
  | 'competing_attempt_lineage'
  | 'synthetic_unknown_isolated'
  | 'historical_isolated_baseline'
  | 'signing_zero_attempts_recovery_required';

export interface Phase10RestoreFinding {
  readonly category: Phase10RestoreFindingCategory;
  readonly severity: 'INFO' | 'WARN' | 'DANGER';
  readonly withdrawalId: string | null;
  readonly publicId: string | null;
  readonly attemptId: string | null;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Phase10HistoricalBaselineAttemptState {
  readonly withdrawalId: string;
  readonly broadcastResultState: string;
  readonly broadcastSubmittedAt: string | null;
  readonly ambiguityClass: string | null;
  readonly withdrawalState: string;
  readonly approvedOutboxStatus: string | null;
  readonly workflowId: string | null;
  readonly newerAttemptLineageCount: number;
  readonly hasPendingApprovedOutbox: boolean;
}

/**
 * Authoritative baseline of historical ambiguous attempts captured BEFORE the
 * controlled campaign / live authorization window. Never uses hardcoded public IDs.
 * Prefer a canonical artifact from capturePhase10HistoricalBaseline — arbitrary
 * ID lists plus a caller-supplied timestamp alone are not authoritative.
 */
export interface Phase10HistoricalBaselineInput {
  readonly attemptIds: readonly string[];
  /** ISO timestamp from the capture tool — attempts must predate this window. */
  readonly capturedAt: string;
  /** Optional per-attempt state snapshot; when present, current state must match. */
  readonly attemptStates?: Readonly<Record<string, Phase10HistoricalBaselineAttemptState>>;
  /** Digest from the canonical capture artifact (when available). */
  readonly artifactDigest?: string;
  /**
   * When true, baseline membership requires attemptStates (canonical capture).
   * Loose ID-only baselines cannot manufacture HISTORICAL_ISOLATED_BASELINE.
   */
  readonly requireCanonicalArtifact?: boolean;
}

export interface Phase10RestoreReconcileScanOptions {
  readonly baselineIsolatedHistoricalAttemptIds?: readonly string[];
  readonly historicalBaseline?: Phase10HistoricalBaselineInput | null;
  /** Campaign / live window start — attempts must predate this when baseline-tolerated. */
  readonly liveAuthorizationWindowStartedAt?: string | Date | null;
  readonly campaignCreatedAt?: string | Date | null;
}

export interface Phase10RestoreReconcileScanReport {
  readonly scannedAt: string;
  readonly dangerousCount: number;
  readonly warnCount: number;
  readonly historicalIsolatedBaselineCount: number;
  readonly findings: readonly Phase10RestoreFinding[];
  readonly byCategory: Readonly<Record<Phase10RestoreFindingCategory, number>>;
  /** Always false — this scanner never auto-resends or unpauses. */
  readonly autoResend: false;
  readonly autoUnpause: false;
}

function emptyCounts(): Record<Phase10RestoreFindingCategory, number> {
  return {
    approved_without_workflow: 0,
    workflow_without_db: 0,
    submitted_unknown_need_chain: 0,
    confirmed_without_settlement: 0,
    settlement_state_mismatch: 0,
    pending_outbox_recovery: 0,
    competing_attempt_lineage: 0,
    synthetic_unknown_isolated: 0,
    historical_isolated_baseline: 0,
    signing_zero_attempts_recovery_required: 0,
  };
}

function parseIsoMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function resolveBaseline(options: Phase10RestoreReconcileScanOptions | undefined): {
  readonly ids: ReadonlySet<string>;
  readonly capturedAtMs: number | null;
  readonly windowStartMs: number | null;
  readonly attemptStates: Readonly<Record<string, Phase10HistoricalBaselineAttemptState>>;
  readonly requireCanonicalArtifact: boolean;
} {
  const baseline = options?.historicalBaseline ?? null;
  const requireCanonicalArtifact = baseline?.requireCanonicalArtifact === true;
  // Loose legacy ID lists without canonical attemptStates cannot isolate danger.
  const looseIds = requireCanonicalArtifact
    ? []
    : (options?.baselineIsolatedHistoricalAttemptIds ?? []);
  const ids = new Set<string>(
    [...(baseline?.attemptIds ?? []), ...looseIds].filter(
      (id) => typeof id === 'string' && id.trim() !== '',
    ),
  );
  const capturedAtMs = parseIsoMs(baseline?.capturedAt ?? null);
  const windowStartMs =
    parseIsoMs(options?.liveAuthorizationWindowStartedAt) ??
    parseIsoMs(options?.campaignCreatedAt) ??
    capturedAtMs;
  return {
    ids,
    capturedAtMs,
    windowStartMs,
    attemptStates: baseline?.attemptStates ?? {},
    requireCanonicalArtifact,
  };
}

async function withClient<T>(
  db: Pool | PoolClient,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Read-only post-restore reconciliation scanner.
 * Never auto-resends. Never unpauses. Never mutates rows.
 */
export async function runPhase10RestoreReconcileScan(
  db: Pool | PoolClient,
  options: Phase10RestoreReconcileScanOptions = {},
): Promise<Phase10RestoreReconcileScanReport> {
  return withClient(db, async (client) => {
    const findings: Phase10RestoreFinding[] = [];
    const byCategory = emptyCounts();
    const baseline = resolveBaseline(options);

    const push = (finding: Phase10RestoreFinding): void => {
      findings.push(finding);
      byCategory[finding.category] += 1;
    };

    // APPROVED / QUEUED without workflow_id and without DISPATCHED approved outbox.
    const approvedWithoutWorkflow = await client.query<{
      id: string;
      public_id: string;
      state: string;
      workflow_id: string | null;
    }>(
      `SELECT w.id, w.public_id, w.state::text AS state, w.workflow_id
       FROM withdrawals w
       WHERE w.state IN ('APPROVED', 'QUEUED')
         AND (w.workflow_id IS NULL OR btrim(w.workflow_id) = '')
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events o
           WHERE o.event_type = $1
             AND o.status = 'DISPATCHED'
             AND (o.aggregate_id = w.id OR (o.payload->>'withdrawalId') = w.id::text)
         )`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    for (const row of approvedWithoutWorkflow.rows) {
      push({
        category: 'approved_without_workflow',
        severity: 'DANGER',
        withdrawalId: row.id,
        publicId: row.public_id,
        attemptId: null,
        message: 'approved/queued withdrawal lacks workflow id and dispatched outbox',
        details: { state: row.state },
      });
    }

    // SIGNING + zero attempts + no broadcast evidence + stale/expired unreleased lease.
    // Read-only detection only — never auto-release lease, refund, cancel, or redispatch.
    const signingZeroAttempts = await client.query<{
      id: string;
      public_id: string;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      lease_released_at: Date | null;
      lease_fencing_token: string | null;
    }>(
      `SELECT w.id, w.public_id,
              l.owner_identity AS lease_owner,
              l.expires_at AS lease_expires_at,
              l.released_at AS lease_released_at,
              l.fencing_token::text AS lease_fencing_token
       FROM withdrawals w
       LEFT JOIN hot_wallet_dispatch_leases l
         ON l.hot_wallet_id = w.hot_wallet_id
        AND l.owner_identity = ('withdrawal:' || w.id::text)
       WHERE w.state = 'SIGNING'
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_attempts a WHERE a.withdrawal_id = w.id
         )`,
    );
    for (const row of signingZeroAttempts.rows) {
      const leaseUnreleased = row.lease_released_at === null && row.lease_owner !== null;
      const leaseExpired =
        leaseUnreleased &&
        row.lease_expires_at !== null &&
        row.lease_expires_at.getTime() <= Date.now();
      const staleOrExpiredLease =
        leaseUnreleased && (leaseExpired || row.lease_expires_at === null);
      push({
        category: 'signing_zero_attempts_recovery_required',
        severity: 'DANGER',
        withdrawalId: row.id,
        publicId: row.public_id,
        attemptId: null,
        message:
          'SIGNING with zero attempts and no broadcast evidence; recovery-required (no auto lease release)',
        details: {
          attemptCount: 0,
          broadcastEvidence: false,
          leaseOwner: row.lease_owner,
          leaseFencingToken: row.lease_fencing_token,
          leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
          leaseReleasedAt: row.lease_released_at?.toISOString() ?? null,
          staleOrExpiredUnreleasedLease: staleOrExpiredLease,
          autoReleaseForbidden: true,
          autoRedispatchForbidden: true,
        },
      });
    }

    // Outbox / workflow_id references a missing withdrawal row.
    const workflowWithoutDb = await client.query<{
      outbox_id: string;
      withdrawal_id: string | null;
      workflow_id: string | null;
    }>(
      `SELECT o.id AS outbox_id,
              COALESCE(o.aggregate_id::text, o.payload->>'withdrawalId') AS withdrawal_id,
              COALESCE(o.payload->>'workflowId', NULL) AS workflow_id
       FROM outbox_events o
       WHERE o.event_type = $1
         AND COALESCE(o.aggregate_id::text, o.payload->>'withdrawalId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM withdrawals w
           WHERE w.id::text = COALESCE(o.aggregate_id::text, o.payload->>'withdrawalId')
         )`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    for (const row of workflowWithoutDb.rows) {
      push({
        category: 'workflow_without_db',
        severity: 'DANGER',
        withdrawalId: row.withdrawal_id,
        publicId: null,
        attemptId: null,
        message: 'approved outbox references missing withdrawal',
        details: {
          outboxId: row.outbox_id,
          expectedWorkflowId:
            row.workflow_id ??
            (row.withdrawal_id !== null ? withdrawalWorkflowId(row.withdrawal_id) : null),
        },
      });
    }

    const orphanWorkflowIds = await client.query<{
      id: string;
      public_id: string;
      workflow_id: string;
    }>(
      `SELECT id, public_id, workflow_id
       FROM withdrawals
       WHERE workflow_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events o
           WHERE o.event_type = $1
             AND (o.aggregate_id = withdrawals.id
                  OR (o.payload->>'withdrawalId') = withdrawals.id::text)
         )
         AND state IN ('APPROVED', 'QUEUED', 'SIGNING', 'BROADCASTING', 'BROADCASTED',
                       'CONFIRMING', 'RECONCILE_REQUIRED')`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    for (const row of orphanWorkflowIds.rows) {
      push({
        category: 'workflow_without_db',
        severity: 'WARN',
        withdrawalId: row.id,
        publicId: row.public_id,
        attemptId: null,
        message: 'withdrawal has workflow_id but no approved outbox row',
        details: { workflowId: row.workflow_id },
      });
    }

    const submittedUnknown = await client.query<{
      id: string;
      withdrawal_id: string;
      public_id: string;
      broadcast_result_state: string;
      broadcast_submitted_at: Date | null;
      broadcast_ambiguity_class: string | null;
      attempt_created_at: Date;
      has_pending_outbox: boolean;
      newer_attempt_count: number;
      withdrawal_state: string;
      workflow_id: string | null;
    }>(
      `SELECT a.id, a.withdrawal_id, w.public_id,
              a.broadcast_result_state::text AS broadcast_result_state,
              a.broadcast_submitted_at, a.broadcast_ambiguity_class,
              a.created_at AS attempt_created_at,
              EXISTS (
                SELECT 1 FROM outbox_events o
                WHERE o.event_type = $1
                  AND o.status = 'PENDING'
                  AND (o.aggregate_id = a.withdrawal_id
                       OR (o.payload->>'withdrawalId') = a.withdrawal_id::text)
              ) AS has_pending_outbox,
              (
                SELECT count(*)::int FROM withdrawal_attempts a2
                WHERE a2.withdrawal_id = a.withdrawal_id
                  AND a2.id <> a.id
                  AND a2.created_at > a.created_at
              ) AS newer_attempt_count,
              w.state::text AS withdrawal_state,
              w.workflow_id
       FROM withdrawal_attempts a
       JOIN withdrawals w ON w.id = a.withdrawal_id
       WHERE a.broadcast_submitted_at IS NOT NULL
         AND a.broadcast_result_state IN ('UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED', 'PENDING')
         AND w.state NOT IN ('CONFIRMED', 'REJECTED', 'FAILED_PRE_BROADCAST')`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    const dispatchableStates = new Set([
      'APPROVED',
      'QUEUED',
      'SIGNING',
      'BROADCASTING',
      'BROADCASTED',
      'CONFIRMING',
      'RECONCILE_REQUIRED',
    ]);
    for (const row of submittedUnknown.rows) {
      const inBaseline = baseline.ids.has(row.id);
      const attemptMs = (row.broadcast_submitted_at ?? row.attempt_created_at).getTime();
      const predatesWindow =
        baseline.windowStartMs !== null && Number.isFinite(attemptMs)
          ? attemptMs < baseline.windowStartMs
          : false;
      const expectedState = baseline.attemptStates[row.id];
      // Canonical artifacts require an exact captured state snapshot per attempt.
      const hasCanonicalState = !baseline.requireCanonicalArtifact || expectedState !== undefined;
      const fullStateMatch =
        expectedState === undefined
          ? !baseline.requireCanonicalArtifact
          : expectedState.withdrawalId === row.withdrawal_id &&
            expectedState.broadcastResultState === row.broadcast_result_state &&
            (expectedState.broadcastSubmittedAt === null ||
              expectedState.broadcastSubmittedAt === row.broadcast_submitted_at!.toISOString()) &&
            (expectedState.ambiguityClass ?? null) === (row.broadcast_ambiguity_class ?? null) &&
            expectedState.withdrawalState === row.withdrawal_state &&
            (expectedState.workflowId ?? null) === (row.workflow_id ?? null) &&
            expectedState.newerAttemptLineageCount === row.newer_attempt_count &&
            expectedState.hasPendingApprovedOutbox === row.has_pending_outbox &&
            !(
              !dispatchableStates.has(expectedState.withdrawalState) &&
              dispatchableStates.has(row.withdrawal_state)
            );
      const noResendPath = !row.has_pending_outbox;
      const noNewerLineage = row.newer_attempt_count === 0;
      const capturedAtPresent = baseline.capturedAtMs !== null;

      if (
        inBaseline &&
        capturedAtPresent &&
        hasCanonicalState &&
        predatesWindow &&
        noResendPath &&
        noNewerLineage &&
        fullStateMatch
      ) {
        push({
          category: 'historical_isolated_baseline',
          severity: 'WARN',
          withdrawalId: row.withdrawal_id,
          publicId: row.public_id,
          attemptId: row.id,
          message:
            'HISTORICAL_ISOLATED_BASELINE: ambiguous attempt authoritatively isolated from new campaign danger',
          details: {
            historicalIsolatedBaseline: true,
            classification: 'HISTORICAL_ISOLATED_BASELINE',
            broadcastResultState: row.broadcast_result_state,
            ambiguityClass: row.broadcast_ambiguity_class,
            predatesWindow: true,
            pendingApprovedOutbox: false,
            newerAttemptCount: 0,
          },
        });
        continue;
      }

      // Baseline claimed but isolation invariants failed → remain DANGER.
      const baselineFailureReasons: string[] = [];
      if (inBaseline) {
        if (!capturedAtPresent) baselineFailureReasons.push('missing_captured_at');
        if (!hasCanonicalState) baselineFailureReasons.push('missing_canonical_state_snapshot');
        if (!predatesWindow) baselineFailureReasons.push('does_not_predate_window');
        if (!noResendPath) baselineFailureReasons.push('pending_approved_outbox');
        if (!noNewerLineage) baselineFailureReasons.push('newer_attempt_lineage');
        if (!fullStateMatch) baselineFailureReasons.push('state_changed_from_baseline');
      }

      push({
        category: 'submitted_unknown_need_chain',
        severity: 'DANGER',
        withdrawalId: row.withdrawal_id,
        publicId: row.public_id,
        attemptId: row.id,
        message: 'submitted/unknown attempt needs chain observation (do not blind-resend)',
        details: {
          broadcastResultState: row.broadcast_result_state,
          ambiguityClass: row.broadcast_ambiguity_class,
          inBaseline,
          baselineFailureReasons,
          hasPendingOutbox: row.has_pending_outbox,
          newerAttemptCount: row.newer_attempt_count,
        },
      });
    }

    const confirmedWithoutSettlement = await client.query<{
      id: string;
      public_id: string;
      settlement_ledger_tx_id: string | null;
    }>(
      `SELECT id, public_id, settlement_ledger_tx_id
       FROM withdrawals
       WHERE state = 'CONFIRMED' AND settlement_ledger_tx_id IS NULL`,
    );
    for (const row of confirmedWithoutSettlement.rows) {
      push({
        category: 'confirmed_without_settlement',
        severity: 'DANGER',
        withdrawalId: row.id,
        publicId: row.public_id,
        attemptId: null,
        message: 'CONFIRMED withdrawal missing settlement_ledger_tx_id',
      });
    }

    const settlementMismatch = await client.query<{
      id: string;
      public_id: string;
      state: string;
      settlement_ledger_tx_id: string;
    }>(
      `SELECT id, public_id, state::text AS state, settlement_ledger_tx_id
       FROM withdrawals
       WHERE settlement_ledger_tx_id IS NOT NULL
         AND state <> 'CONFIRMED'`,
    );
    for (const row of settlementMismatch.rows) {
      push({
        category: 'settlement_state_mismatch',
        severity: 'DANGER',
        withdrawalId: row.id,
        publicId: row.public_id,
        attemptId: null,
        message: 'settlement present but state is not CONFIRMED',
        details: { state: row.state, settlementLedgerTxId: row.settlement_ledger_tx_id },
      });
    }

    const pendingOutbox = await client.query<{
      id: string;
      aggregate_id: string | null;
      payload_withdrawal_id: string | null;
      attempts: number;
    }>(
      `SELECT id, aggregate_id,
              payload->>'withdrawalId' AS payload_withdrawal_id,
              attempts
       FROM outbox_events
       WHERE event_type = $1 AND status = 'PENDING'`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    for (const row of pendingOutbox.rows) {
      const withdrawalId = row.aggregate_id ?? row.payload_withdrawal_id;
      push({
        category: 'pending_outbox_recovery',
        severity: 'WARN',
        withdrawalId,
        publicId: null,
        attemptId: null,
        message:
          'PENDING withdrawal.approved outbox requires Owner-gated recovery (never auto-resend)',
        details: { outboxId: row.id, attempts: row.attempts },
      });
    }

    const competing = await client.query<{
      withdrawal_id: string;
      public_id: string;
      live_count: number;
    }>(
      `SELECT a.withdrawal_id, w.public_id, count(*)::int AS live_count
       FROM withdrawal_attempts a
       JOIN withdrawals w ON w.id = a.withdrawal_id
       WHERE a.broadcast_result_state IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED')
       GROUP BY a.withdrawal_id, w.public_id
       HAVING count(*) > 1`,
    );
    for (const row of competing.rows) {
      push({
        category: 'competing_attempt_lineage',
        severity: 'DANGER',
        withdrawalId: row.withdrawal_id,
        publicId: row.public_id,
        attemptId: null,
        message: 'competing live attempt lineage',
        details: { liveCount: row.live_count },
      });
    }

    const syntheticUnknown = await client.query<{
      id: string;
      withdrawal_id: string;
      public_id: string;
      has_pending_outbox: boolean;
    }>(
      `SELECT a.id, a.withdrawal_id, w.public_id,
              EXISTS (
                SELECT 1 FROM outbox_events o
                WHERE o.event_type = $1
                  AND o.status = 'PENDING'
                  AND (o.aggregate_id = a.withdrawal_id
                       OR (o.payload->>'withdrawalId') = a.withdrawal_id::text)
              ) AS has_pending_outbox
       FROM withdrawal_attempts a
       JOIN withdrawals w ON w.id = a.withdrawal_id
       WHERE a.broadcast_result_state = 'UNKNOWN'
          OR a.broadcast_ambiguity_class IS NOT NULL`,
      [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
    );
    for (const row of syntheticUnknown.rows) {
      push({
        category: 'synthetic_unknown_isolated',
        severity: row.has_pending_outbox ? 'WARN' : 'INFO',
        withdrawalId: row.withdrawal_id,
        publicId: row.public_id,
        attemptId: row.id,
        message: row.has_pending_outbox
          ? 'UNKNOWN/ambiguous attempt still coupled to PENDING approved outbox'
          : 'UNKNOWN/ambiguous attempt isolated from PENDING approved outbox',
        details: { isolated: !row.has_pending_outbox },
      });
    }

    return {
      scannedAt: new Date().toISOString(),
      dangerousCount: findings.filter((f) => f.severity === 'DANGER').length,
      warnCount: findings.filter((f) => f.severity === 'WARN').length,
      historicalIsolatedBaselineCount: findings.filter(
        (f) => f.category === 'historical_isolated_baseline',
      ).length,
      findings,
      byCategory,
      autoResend: false,
      autoUnpause: false,
    };
  });
}
