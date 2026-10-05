import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Pool, PoolClient } from 'pg';

import { evaluateFailedPreBroadcastReuse } from './failed-pre-reuse.js';
import {
  WITHDRAWAL_APPROVED_OUTBOX_EVENT,
  WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT,
  WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
  withdrawalWorkflowId,
} from './outbox.js';
import { WITHDRAWAL_CONFIRMED_OUTBOX_EVENT } from './public-payout-outbox.js';

export const WITHDRAWAL_PAYOUT_WORKFLOW_TYPE = 'withdrawalPayoutWorkflow' as const;

export interface WithdrawalApprovedOutboxEvent {
  readonly id: string;
  readonly aggregateId: string | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly availableAt: Date;
}

export interface StartWithdrawalWorkflowResult {
  readonly workflowId: string;
  readonly withdrawalId: string;
  readonly alreadyStarted: boolean;
}

export type TemporalWorkflowIdReusePolicy = 'REJECT_DUPLICATE' | 'ALLOW_DUPLICATE';

/** Minimal Temporal client surface used by the outbox relay (real Client or test double). */
export type TemporalWorkflowStarter = {
  readonly workflow: {
    start(
      workflowTypeOrFunc: string,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [{ withdrawalId: string; realChainEnabled?: boolean }];
        workflowIdReusePolicy?: TemporalWorkflowIdReusePolicy;
        workflowIdConflictPolicy?: 'FAIL';
      },
    ): Promise<unknown>;
    /**
     * Optional: used by failed-pre retry to refuse when a prior run is still RUNNING.
     * Real Temporal Client exposes getHandle(...).describe().
     */
    getHandle?(workflowId: string): {
      describe(): Promise<{ status: { name?: string } | string | number }>;
    };
  };
};

const MAX_BACKOFF_SECONDS = 300;

export function redactOutboxError(error: unknown): string {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
    .replace(/redis(?:s)?:\/\/[^\s'"]+/gi, 'redis://[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/password=[^&\s'"]+/gi, 'password=[redacted]');
  return message.slice(0, 500);
}

export function outboxRetryBackoffSeconds(attemptsBeforeIncrement: number): number {
  const safe = Math.max(0, Math.floor(attemptsBeforeIncrement));
  // Cap exponent before 2**n so we never overflow Number / SQL int (2**31).
  const cappedExp = Math.min(safe, 8);
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(1, 2 ** cappedExp));
}

function isAlreadyStarted(error: unknown): boolean {
  return error instanceof WorkflowExecutionAlreadyStartedError;
}

function resolveWithdrawalId(event: WithdrawalApprovedOutboxEvent): string {
  const fromPayload = event.payload.withdrawalId;
  if (typeof fromPayload === 'string' && fromPayload.trim() !== '') {
    return fromPayload;
  }
  if (event.aggregateId !== null && event.aggregateId.trim() !== '') {
    return event.aggregateId;
  }
  throw new Error(`${event.eventType} outbox payload missing withdrawalId`);
}

function resolveWorkflowId(event: WithdrawalApprovedOutboxEvent, withdrawalId: string): string {
  const fromPayload = event.payload.workflowId;
  if (typeof fromPayload === 'string' && fromPayload.trim() !== '') {
    return fromPayload;
  }
  return withdrawalWorkflowId(withdrawalId);
}

function describeStatusName(status: { name?: string } | string | number | undefined): string {
  if (status === undefined || status === null) return '';
  if (typeof status === 'string') return status.toUpperCase();
  if (typeof status === 'number') return String(status);
  if (typeof status.name === 'string') return status.name.toUpperCase();
  return '';
}

/**
 * Claim PENDING withdrawal.approved outbox rows (caller must be in a transaction).
 * Serialization is FOR UPDATE SKIP LOCKED on the selected rows while the transaction
 * is open — available_at is NOT fencing and is not bumped here.
 */

export async function claimPendingWithdrawalConfirmedEvents(
  client: PoolClient,
  limit: number,
): Promise<WithdrawalApprovedOutboxEvent[]> {
  return claimPendingOutboxEventsByType(client, WITHDRAWAL_CONFIRMED_OUTBOX_EVENT, limit);
}

export async function claimPendingWithdrawalApprovedEvents(
  client: PoolClient,
  limit: number,
): Promise<WithdrawalApprovedOutboxEvent[]> {
  return claimPendingOutboxEventsByType(client, WITHDRAWAL_APPROVED_OUTBOX_EVENT, limit);
}

export async function claimPendingFailedPreRetryEvents(
  client: PoolClient,
  limit: number,
): Promise<WithdrawalApprovedOutboxEvent[]> {
  return claimPendingOutboxEventsByType(client, WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT, limit);
}

/**
 * Claim PENDING withdrawal.owner_review_required outbox rows and lease them
 * (bump available_at) so concurrent pollers skip until success/retry.
 */
export async function claimPendingOwnerReviewRequiredEvents(
  client: PoolClient,
  limit: number,
  leaseSeconds = 120,
): Promise<WithdrawalApprovedOutboxEvent[]> {
  const events = await claimPendingOutboxEventsByType(
    client,
    WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
    limit,
  );
  const lease = Math.max(30, Math.min(600, Math.floor(leaseSeconds)));
  for (const event of events) {
    await client.query(
      `UPDATE outbox_events
       SET available_at = now() + make_interval(secs => $2::int)
       WHERE id = $1::uuid AND status = 'PENDING'`,
      [event.id, lease],
    );
  }
  return events;
}

async function claimPendingOutboxEventsByType(
  client: PoolClient,
  eventType: string,
  limit: number,
): Promise<WithdrawalApprovedOutboxEvent[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await client.query<{
    id: string;
    aggregate_id: string | null;
    event_type: string;
    payload: Record<string, unknown>;
    attempts: number;
    available_at: Date;
  }>(
    `SELECT id, aggregate_id, event_type, payload, attempts, available_at
     FROM outbox_events
     WHERE event_type = $1
       AND status = 'PENDING'
       AND available_at <= now()
     ORDER BY available_at ASC, created_at ASC
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [eventType, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload ?? {},
    attempts: row.attempts,
    availableAt: row.available_at,
  }));
}

export async function markOutboxDispatched(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE outbox_events
     SET status = 'DISPATCHED',
         dispatched_at = now(),
         last_error_redacted = NULL
     WHERE id = $1::uuid`,
    [id],
  );
}

export async function markOutboxDeadLetter(
  client: PoolClient,
  id: string,
  errorMessage: unknown,
): Promise<void> {
  const redacted = redactOutboxError(errorMessage);
  await client.query(
    `UPDATE outbox_events
     SET status = 'DEAD_LETTER',
         last_error_redacted = $2,
         attempts = attempts + 1
     WHERE id = $1::uuid
       AND status = 'PENDING'`,
    [id, redacted],
  );
}

/**
 * Leave status PENDING, increment attempts, store redacted error, schedule backoff.
 * PostgreSQL SET RHS expressions see pre-update column values.
 */
export async function markOutboxRetry(
  client: PoolClient,
  id: string,
  errorMessage: unknown,
): Promise<void> {
  const redacted = redactOutboxError(errorMessage);
  // Clamp exponent BEFORE casting to int — POWER(2, attempts)::int overflows at attempts>=31
  // if LEAST is applied after the cast.
  await client.query(
    `UPDATE outbox_events
     SET attempts = attempts + 1,
         last_error_redacted = $2,
         available_at = now() + make_interval(
           secs => LEAST(
             $3::int,
             GREATEST(1, (POWER(2, LEAST(attempts, 8)))::int)
           )
         )
     WHERE id = $1::uuid
       AND status = 'PENDING'`,
    [id, redacted, MAX_BACKOFF_SECONDS],
  );
}

export async function startWithdrawalWorkflowFromOutbox(
  temporalClient: TemporalWorkflowStarter,
  event: WithdrawalApprovedOutboxEvent,
  taskQueue: string,
  options?: {
    readonly realChainEnabled?: boolean;
    readonly workflowIdReusePolicy?: TemporalWorkflowIdReusePolicy;
  },
): Promise<StartWithdrawalWorkflowResult> {
  const withdrawalId = resolveWithdrawalId(event);
  const workflowId = resolveWorkflowId(event, withdrawalId);
  const reusePolicy = options?.workflowIdReusePolicy ?? 'REJECT_DUPLICATE';
  try {
    await temporalClient.workflow.start(WITHDRAWAL_PAYOUT_WORKFLOW_TYPE, {
      taskQueue,
      workflowId,
      args: [
        {
          withdrawalId,
          ...(options?.realChainEnabled === true ? { realChainEnabled: true } : {}),
        },
      ],
      workflowIdReusePolicy: reusePolicy,
      workflowIdConflictPolicy: 'FAIL',
    });
    return { workflowId, withdrawalId, alreadyStarted: false };
  } catch (error) {
    if (isAlreadyStarted(error)) {
      return { workflowId, withdrawalId, alreadyStarted: true };
    }
    throw error;
  }
}

/**
 * Before ALLOW_DUPLICATE start: refuse when an execution for this workflowId is RUNNING.
 * Missing workflow / closed run → allow. Errors from describe are treated as unknown → allow
 * Temporal start to apply ConflictPolicy (fail closed on concurrent).
 */
export async function assertNoRunningWithdrawalWorkflow(
  temporalClient: TemporalWorkflowStarter,
  workflowId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const getHandle = temporalClient.workflow.getHandle;
  if (typeof getHandle !== 'function') {
    return { ok: true };
  }
  try {
    const described = await getHandle.call(temporalClient.workflow, workflowId).describe();
    const name = describeStatusName(described.status);
    if (name.includes('RUNNING') || name === '1' || name === 'WORKFLOW_EXECUTION_STATUS_RUNNING') {
      return { ok: false, reason: 'workflow_still_running' };
    }
    return { ok: true };
  } catch {
    // Not found / closed / describe unsupported → proceed; start + ConflictPolicy decide.
    return { ok: true };
  }
}

export interface ProcessWithdrawalApprovedOutboxBatchOptions {
  readonly client: TemporalWorkflowStarter;
  readonly taskQueue: string;
  /**
   * LOCAL/TEST indicator. Relay starts Temporal regardless; activities fail closed
   * when the fake chain is disabled. Kept for callers / future production gating.
   */
  readonly fakeChainEnabled: boolean;
  /**
   * Phase 10: when true (and fake chain off), workflow selects Testnet activity.
   * Default false preserves Phase 7 fake Temporal tests.
   */
  readonly realChainEnabled?: boolean;
  readonly limit?: number;
}

export interface ProcessWithdrawalApprovedOutboxBatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly retried: number;
  readonly deadLetter?: number;
}

/**
 * Claim PENDING withdrawal.approved events and start Temporal workflows.
 * WorkflowExecutionAlreadyStarted → success (DISPATCHED).
 * Temporal unavailable → leave PENDING, increment attempts, store redacted error.
 * Uses REJECT_DUPLICATE (ADR-017 first-start path).
 */
export async function processWithdrawalApprovedOutboxBatch(
  pool: Pool,
  options: ProcessWithdrawalApprovedOutboxBatchOptions,
): Promise<ProcessWithdrawalApprovedOutboxBatchResult> {
  void options.fakeChainEnabled;
  const realChainEnabled = options.realChainEnabled === true && options.fakeChainEnabled === false;
  const limit = options.limit ?? 20;
  const client = await pool.connect();
  let dispatched = 0;
  let retried = 0;
  try {
    await client.query('BEGIN');
    const events = await claimPendingWithdrawalApprovedEvents(client, limit);
    const claimed = events.length;

    for (const event of events) {
      try {
        const started = await startWithdrawalWorkflowFromOutbox(
          options.client,
          event,
          options.taskQueue,
          { realChainEnabled, workflowIdReusePolicy: 'REJECT_DUPLICATE' },
        );
        void started;
        await markOutboxDispatched(client, event.id);
        dispatched += 1;
      } catch (error) {
        if (isAlreadyStarted(error)) {
          await markOutboxDispatched(client, event.id);
          dispatched += 1;
          continue;
        }
        // Stay PENDING / retryable — never mark DISPATCHED on start failure.
        await markOutboxRetry(client, event.id, error);
        retried += 1;
      }
    }

    await client.query('COMMIT');
    return { claimed, dispatched, retried };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claim PENDING withdrawal.failed_pre_retry events and restart `withdrawal/{id}`
 * with ALLOW_DUPLICATE after re-verifying FAILED_PRE reuse safety.
 *
 * - Unsafe reuse → DEAD_LETTER (no Temporal start)
 * - RUNNING prior workflow → DEAD_LETTER (no concurrent mint)
 * - AlreadyStarted / successful start → DISPATCHED (idempotent across relay retries)
 */
export async function processWithdrawalFailedPreRetryOutboxBatch(
  pool: Pool,
  options: ProcessWithdrawalApprovedOutboxBatchOptions,
): Promise<ProcessWithdrawalApprovedOutboxBatchResult> {
  void options.fakeChainEnabled;
  const realChainEnabled = options.realChainEnabled === true && options.fakeChainEnabled === false;
  const limit = options.limit ?? 20;
  const client = await pool.connect();
  let dispatched = 0;
  let retried = 0;
  let deadLetter = 0;
  try {
    await client.query('BEGIN');
    const events = await claimPendingFailedPreRetryEvents(client, limit);
    const claimed = events.length;

    for (const event of events) {
      try {
        const withdrawalId = resolveWithdrawalId(event);
        const workflowId = resolveWorkflowId(event, withdrawalId);

        const evaluation = await evaluateFailedPreBroadcastReuse(client, withdrawalId);
        if (!evaluation.ok) {
          await markOutboxDeadLetter(
            client,
            event.id,
            `reuse_refused:${evaluation.refusalReasons.join(',')}`,
          );
          deadLetter += 1;
          continue;
        }

        const running = await assertNoRunningWithdrawalWorkflow(options.client, workflowId);
        if (!running.ok) {
          await markOutboxDeadLetter(client, event.id, running.reason);
          deadLetter += 1;
          continue;
        }

        const started = await startWithdrawalWorkflowFromOutbox(
          options.client,
          event,
          options.taskQueue,
          { realChainEnabled, workflowIdReusePolicy: 'ALLOW_DUPLICATE' },
        );
        void started;
        await markOutboxDispatched(client, event.id);
        dispatched += 1;
      } catch (error) {
        if (isAlreadyStarted(error)) {
          // Concurrent relay / still-running race: treat as successful handoff.
          await markOutboxDispatched(client, event.id);
          dispatched += 1;
          continue;
        }
        await markOutboxRetry(client, event.id, error);
        retried += 1;
      }
    }

    await client.query('COMMIT');
    return { claimed, dispatched, retried, deadLetter };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}
