/**
 * Read-only evaluation + Owner-gated outbox enqueue for FAILED_PRE_BROADCAST reuse.
 *
 * Allows Temporal redispatch of the SAME withdrawal when:
 * - state is FAILED_PRE_BROADCAST
 * - every existing attempt (0..N) is definitively FAILED_PRE_BROADCAST with
 *   no signature, no broadcast submit, no chain reference, no message hashes,
 *   and no ambiguous chain outcome
 * - reservation held, lease released, no settlement/release
 *
 * Enqueue inserts a transactional outbox row only. It does not unlock the signer,
 * clear pause, enable real chain, create withdrawals, or touch the ledger.
 * Attempt #N+1 is created only later by the payout pipeline after checks pass.
 */

import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog, insertWithdrawalOutboxEvent } from './audit.js';
import { withWithdrawalTransaction, type WithdrawalDb, isPool } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { hotWalletDispatchOwnerIdentity } from './hot-wallet-dispatch-lease.js';
import {
  WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT,
  withdrawalFailedPreRetryDedupeKey,
  withdrawalWorkflowId,
} from './outbox.js';

export interface FailedPreBroadcastReuseSnapshot {
  readonly withdrawalId: string;
  readonly publicId: string | null;
  readonly state: string;
  readonly assetSymbol: string | null;
  readonly reservationLedgerTxId: string | null;
  readonly releaseLedgerTxId: string | null;
  readonly settlementLedgerTxId: string | null;
  readonly attemptCount: number;
  /** Attempts with any signature / Boc / message-hash evidence. */
  readonly signatureEvidenceAttemptCount: number;
  readonly broadcastSubmittedAttemptCount: number;
  readonly chainReferenceAttemptCount: number;
  /** Attempts not in FAILED_PRE_BROADCAST (PENDING/UNKNOWN/…). */
  readonly nonFailedPreAttemptCount: number;
  readonly ambiguousAttemptCount: number;
  readonly leaseReleased: boolean | null;
  readonly leaseOwnerMatches: boolean | null;
  readonly availableAtomic: string | null;
  readonly reservedAtomic: string | null;
}

export interface FailedPreBroadcastReuseEvaluation {
  readonly ok: boolean;
  readonly readyForAuthorizedRetry: boolean;
  readonly refusalReasons: readonly string[];
  readonly snapshot: FailedPreBroadcastReuseSnapshot | null;
}

export interface EnqueueFailedPreBroadcastRetryResult {
  readonly accepted: boolean;
  readonly created: boolean;
  readonly outboxId: string | null;
  readonly workflowId: string;
  readonly retryOrdinal: number | null;
  readonly refusalReasons: readonly string[];
  readonly evaluation: FailedPreBroadcastReuseEvaluation;
}

async function withClient<T>(
  db: WithdrawalDb,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  return fn(db);
}

async function loadReuseEvaluation(
  client: PoolClient,
  withdrawalId: string,
): Promise<FailedPreBroadcastReuseEvaluation> {
  const w = await client.query<{
    id: string;
    public_id: string | null;
    state: string;
    asset_symbol: string | null;
    hot_wallet_id: string | null;
    reservation_ledger_tx_id: string | null;
    release_ledger_tx_id: string | null;
    settlement_ledger_tx_id: string | null;
    user_id: string;
    asset_id: string;
  }>(
    `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
            a.symbol AS asset_symbol, w.hot_wallet_id::text AS hot_wallet_id,
            w.reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
            w.release_ledger_tx_id::text AS release_ledger_tx_id,
            w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
            w.user_id::text AS user_id, w.asset_id::text AS asset_id
     FROM withdrawals w
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE w.id = $1::uuid`,
    [withdrawalId],
  );
  const row = w.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      readyForAuthorizedRetry: false,
      refusalReasons: ['withdrawal_not_found'],
      snapshot: null,
    };
  }

  const attempts = await client.query<{
    c: number;
    signature_evidence: number;
    submitted: number;
    chain_ref: number;
    non_failed_pre: number;
    ambiguous: number;
  }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (
              WHERE signed_external_message_boc IS NOT NULL
                 OR signed_wallet_request_boc IS NOT NULL
                 OR external_message_cell_hash IS NOT NULL
                 OR normalized_external_message_hash IS NOT NULL
                 OR signed_message_hash IS NOT NULL
            )::int AS signature_evidence,
            count(*) FILTER (WHERE broadcast_submitted_at IS NOT NULL)::int AS submitted,
            count(*) FILTER (
              WHERE chain_reference IS NOT NULL AND btrim(chain_reference) <> ''
            )::int AS chain_ref,
            count(*) FILTER (
              WHERE broadcast_result_state::text <> 'FAILED_PRE_BROADCAST'
            )::int AS non_failed_pre,
            count(*) FILTER (
              WHERE broadcast_result_state::text IN (
                'PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'
              )
            )::int AS ambiguous
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  const attemptCount = attempts.rows[0]?.c ?? 0;
  const signatureEvidenceAttemptCount = attempts.rows[0]?.signature_evidence ?? 0;
  const broadcastSubmittedAttemptCount = attempts.rows[0]?.submitted ?? 0;
  const chainReferenceAttemptCount = attempts.rows[0]?.chain_ref ?? 0;
  const nonFailedPreAttemptCount = attempts.rows[0]?.non_failed_pre ?? 0;
  const ambiguousAttemptCount = attempts.rows[0]?.ambiguous ?? 0;

  let leaseReleased: boolean | null = null;
  let leaseOwnerMatches: boolean | null = null;
  if (row.hot_wallet_id !== null) {
    const expectedOwner = hotWalletDispatchOwnerIdentity(withdrawalId);
    const lease = await client.query<{
      released_at: Date | null;
      owner_identity: string;
    }>(
      `SELECT released_at, owner_identity
       FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid`,
      [row.hot_wallet_id],
    );
    const leaseRow = lease.rows[0];
    if (leaseRow === undefined) {
      leaseReleased = null;
      leaseOwnerMatches = null;
    } else {
      leaseReleased = leaseRow.released_at !== null;
      leaseOwnerMatches = leaseRow.owner_identity === expectedOwner;
    }
  }

  const balances = await client.query<{
    account_type: string;
    balance_atomic: string;
  }>(
    `SELECT la.account_type::text AS account_type,
            COALESCE(lab.balance_atomic, 0)::text AS balance_atomic
     FROM ledger_accounts la
     LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
     WHERE la.owner_id = $1::uuid
       AND la.asset_id = $2::uuid
       AND la.account_type IN ('USER_AVAILABLE_LIABILITY', 'USER_RESERVED_LIABILITY')`,
    [row.user_id, row.asset_id],
  );
  const availableAtomic =
    balances.rows.find((b) => b.account_type === 'USER_AVAILABLE_LIABILITY')?.balance_atomic ??
    null;
  const reservedAtomic =
    balances.rows.find((b) => b.account_type === 'USER_RESERVED_LIABILITY')?.balance_atomic ??
    null;

  const snapshot: FailedPreBroadcastReuseSnapshot = {
    withdrawalId: row.id,
    publicId: row.public_id,
    state: row.state,
    assetSymbol: row.asset_symbol,
    reservationLedgerTxId: row.reservation_ledger_tx_id,
    releaseLedgerTxId: row.release_ledger_tx_id,
    settlementLedgerTxId: row.settlement_ledger_tx_id,
    attemptCount,
    signatureEvidenceAttemptCount,
    broadcastSubmittedAttemptCount,
    chainReferenceAttemptCount,
    nonFailedPreAttemptCount,
    ambiguousAttemptCount,
    leaseReleased,
    leaseOwnerMatches,
    availableAtomic,
    reservedAtomic,
  };

  const refusalReasons: string[] = [];
  if (row.state !== 'FAILED_PRE_BROADCAST') {
    refusalReasons.push(`state_not_failed_pre:${row.state}`);
  }
  // Prior attempts may exist only when every one is a clean FAILED_PRE_BROADCAST
  // (no signature, no broadcast, no ambiguous outcome). Zero attempts remain allowed.
  if (nonFailedPreAttemptCount !== 0) {
    refusalReasons.push(`non_failed_pre_attempts:${nonFailedPreAttemptCount}`);
  }
  if (signatureEvidenceAttemptCount !== 0) {
    refusalReasons.push(`signature_evidence_present:${signatureEvidenceAttemptCount}`);
  }
  if (broadcastSubmittedAttemptCount !== 0) {
    refusalReasons.push('broadcast_submitted_evidence_present');
  }
  if (chainReferenceAttemptCount !== 0) {
    refusalReasons.push(`chain_reference_present:${chainReferenceAttemptCount}`);
  }
  if (ambiguousAttemptCount !== 0) {
    refusalReasons.push(`ambiguous_chain_outcome:${ambiguousAttemptCount}`);
  }
  if (row.reservation_ledger_tx_id === null) {
    refusalReasons.push('reservation_missing');
  }
  if (row.release_ledger_tx_id !== null) {
    refusalReasons.push('already_released');
  }
  if (row.settlement_ledger_tx_id !== null) {
    refusalReasons.push('already_settled');
  }
  if (leaseReleased === false) {
    refusalReasons.push('dispatch_lease_still_held');
  }
  if (reservedAtomic === null || BigInt(reservedAtomic) <= 0n) {
    refusalReasons.push('reserved_balance_not_positive');
  }

  const ok = refusalReasons.length === 0;
  return {
    ok,
    readyForAuthorizedRetry: ok,
    refusalReasons,
    snapshot,
  };
}

/**
 * Evaluate whether `withdrawalId` is a safe FAILED_PRE_BROADCAST reuse candidate:
 * clean prior FAILED_PRE attempts (or zero attempts), no ambiguous/broadcast/signature
 * evidence, lease released, reservation held. Does not create attempts.
 */
export async function evaluateFailedPreBroadcastReuse(
  db: WithdrawalDb,
  withdrawalId: string,
): Promise<FailedPreBroadcastReuseEvaluation> {
  return withClient(db, (client) => loadReuseEvaluation(client, withdrawalId));
}

/**
 * Insert a PENDING `withdrawal.failed_pre_retry` outbox event for the same
 * `withdrawal/{id}` workflow id. Idempotent while a PENDING retry already exists.
 * Does not start Temporal, mutate ledger, or create a new withdrawal.
 * Pipeline may later create Attempt #N+1 after re-admission.
 */
export async function enqueueFailedPreBroadcastRetry(
  db: WithdrawalDb,
  input: {
    readonly withdrawalId: string;
    readonly actorAdminUserId?: string | null;
    readonly reason?: string;
  },
): Promise<EnqueueFailedPreBroadcastRetryResult> {
  const workflowId = withdrawalWorkflowId(input.withdrawalId);

  return withWithdrawalTransaction(db, async (client) => {
    await client.query(`SELECT id FROM withdrawals WHERE id = $1::uuid FOR UPDATE`, [
      input.withdrawalId,
    ]);

    const evaluation = await loadReuseEvaluation(client, input.withdrawalId);
    if (!evaluation.ok) {
      return {
        accepted: false,
        created: false,
        outboxId: null,
        workflowId,
        retryOrdinal: null,
        refusalReasons: evaluation.refusalReasons,
        evaluation,
      };
    }

    const pending = await client.query<{ id: string; dedupe_key: string }>(
      `SELECT id::text AS id, dedupe_key
       FROM outbox_events
       WHERE event_type = $1
         AND aggregate_id = $2::uuid
         AND status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT, input.withdrawalId],
    );
    if (pending.rows[0] !== undefined) {
      const ordinalMatch = /:(\d+)$/.exec(pending.rows[0].dedupe_key);
      const retryOrdinal = ordinalMatch !== null ? Number(ordinalMatch[1]) : null;
      return {
        accepted: true,
        created: false,
        outboxId: pending.rows[0].id,
        workflowId,
        retryOrdinal,
        refusalReasons: [],
        evaluation,
      };
    }

    const prior = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM outbox_events
       WHERE event_type = $1
         AND aggregate_id = $2::uuid`,
      [WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT, input.withdrawalId],
    );
    const retryOrdinal = (prior.rows[0]?.c ?? 0) + 1;
    const dedupeKey = withdrawalFailedPreRetryDedupeKey(input.withdrawalId, retryOrdinal);

    const inserted = await insertWithdrawalOutboxEvent(client, {
      aggregateType: 'withdrawal',
      aggregateId: input.withdrawalId,
      eventType: WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT,
      dedupeKey,
      payload: {
        withdrawalId: input.withdrawalId,
        workflowId,
        retryOrdinal,
        kind: 'FAILED_PRE_BROADCAST_RETRY',
        priorAttemptCount: evaluation.snapshot?.attemptCount ?? 0,
      },
    });

    if (!inserted.created) {
      // Race with another enqueue of the same ordinal — treat as idempotent accept.
      return {
        accepted: true,
        created: false,
        outboxId: inserted.id,
        workflowId,
        retryOrdinal,
        refusalReasons: [],
        evaluation,
      };
    }

    await insertWithdrawalAuditLog(client, {
      actionType: 'WITHDRAWAL_FAILED_PRE_RETRY_ENQUEUED',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: input.actorAdminUserId ? 'ADMIN' : 'SYSTEM',
      adminUserId: input.actorAdminUserId ?? null,
      reason: input.reason ?? 'Owner-authorized FAILED_PRE_BROADCAST Temporal redispatch enqueue',
      afterSnapshot: {
        outboxId: inserted.id,
        workflowId,
        retryOrdinal,
        eventType: WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT,
        priorAttemptCount: evaluation.snapshot?.attemptCount ?? 0,
      },
    });

    return {
      accepted: true,
      created: true,
      outboxId: inserted.id,
      workflowId,
      retryOrdinal,
      refusalReasons: [],
      evaluation,
    };
  });
}

export function assertFailedPreBroadcastReuseOrThrow(
  evaluation: FailedPreBroadcastReuseEvaluation,
): void {
  if (!evaluation.ok) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      `FAILED_PRE_BROADCAST reuse refused: ${evaluation.refusalReasons.join(',')}`,
      { details: { refusalReasons: evaluation.refusalReasons } },
    );
  }
}
