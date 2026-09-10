import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Pool, PoolClient } from 'pg';

import { WITHDRAWAL_APPROVED_OUTBOX_EVENT, withdrawalWorkflowId } from './outbox.js';

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

/** Minimal Temporal client surface used by the outbox relay (real Client or test double). */
export type TemporalWorkflowStarter = {
  readonly workflow: {
    start(
      workflowTypeOrFunc: string,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [{ withdrawalId: string; realChainEnabled?: boolean }];
        workflowIdReusePolicy?: 'REJECT_DUPLICATE';
        workflowIdConflictPolicy?: 'FAIL';
      },
    ): Promise<unknown>;
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
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(1, 2 ** safe));
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
  throw new Error('withdrawal.approved outbox payload missing withdrawalId');
}

function resolveWorkflowId(event: WithdrawalApprovedOutboxEvent, withdrawalId: string): string {
  const fromPayload = event.payload.workflowId;
  if (typeof fromPayload === 'string' && fromPayload.trim() !== '') {
    return fromPayload;
  }
  return withdrawalWorkflowId(withdrawalId);
}

/**
 * Claim PENDING withdrawal.approved outbox rows (caller must be in a transaction).
 */
export async function claimPendingWithdrawalApprovedEvents(
  client: PoolClient,
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
    [WITHDRAWAL_APPROVED_OUTBOX_EVENT, safeLimit],
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
  await client.query(
    `UPDATE outbox_events
     SET attempts = attempts + 1,
         last_error_redacted = $2,
         available_at = now() + make_interval(
           secs => LEAST($3::int, GREATEST(1, (POWER(2, attempts))::int))
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
  options?: { readonly realChainEnabled?: boolean },
): Promise<StartWithdrawalWorkflowResult> {
  const withdrawalId = resolveWithdrawalId(event);
  const workflowId = resolveWorkflowId(event, withdrawalId);
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
      // Never mint a second logical payout for the same withdrawal/{id}.
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
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
}

/**
 * Claim PENDING withdrawal.approved events and start Temporal workflows.
 * WorkflowExecutionAlreadyStarted → success (DISPATCHED).
 * Temporal unavailable → leave PENDING, increment attempts, store redacted error.
 */
export async function processWithdrawalApprovedOutboxBatch(
  pool: Pool,
  options: ProcessWithdrawalApprovedOutboxBatchOptions,
): Promise<ProcessWithdrawalApprovedOutboxBatchResult> {
  void options.fakeChainEnabled;
  const realChainEnabled =
    options.realChainEnabled === true && options.fakeChainEnabled === false;
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
          { realChainEnabled },
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
