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
  | 'synthetic_unknown_isolated';

export interface Phase10RestoreFinding {
  readonly category: Phase10RestoreFindingCategory;
  readonly severity: 'INFO' | 'WARN' | 'DANGER';
  readonly withdrawalId: string | null;
  readonly publicId: string | null;
  readonly attemptId: string | null;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Phase10RestoreReconcileScanReport {
  readonly scannedAt: string;
  readonly dangerousCount: number;
  readonly warnCount: number;
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
  };
}

async function withClient<T>(db: Pool | PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
): Promise<Phase10RestoreReconcileScanReport> {
  return withClient(db, async (client) => {
    const findings: Phase10RestoreFinding[] = [];
    const byCategory = emptyCounts();

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
    }>(
      `SELECT a.id, a.withdrawal_id, w.public_id,
              a.broadcast_result_state::text AS broadcast_result_state,
              a.broadcast_submitted_at, a.broadcast_ambiguity_class
       FROM withdrawal_attempts a
       JOIN withdrawals w ON w.id = a.withdrawal_id
       WHERE a.broadcast_submitted_at IS NOT NULL
         AND a.broadcast_result_state IN ('UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED', 'PENDING')
         AND w.state NOT IN ('CONFIRMED', 'REJECTED', 'FAILED_PRE_BROADCAST')`,
    );
    for (const row of submittedUnknown.rows) {
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
        message: 'PENDING withdrawal.approved outbox requires Owner-gated recovery (never auto-resend)',
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
      findings,
      byCategory,
      autoResend: false,
      autoUnpause: false,
    };
  });
}
