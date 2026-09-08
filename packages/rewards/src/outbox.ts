import type { PoolClient } from 'pg';

import { RewardDomainError } from './errors.js';

export interface InsertOutboxEventInput {
  readonly aggregateType: string;
  readonly aggregateId?: string | null;
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  readonly availableAt?: Date;
  readonly traceId?: string | null;
}

/**
 * Insert an outbox row in the caller's transaction.
 * Unique dedupe_key collisions are treated as idempotent success (same event already queued).
 */
export async function insertOutboxEvent(
  client: PoolClient,
  input: InsertOutboxEventInput,
): Promise<{ id: string; created: boolean }> {
  if (input.dedupeKey.trim() === '') {
    throw new RewardDomainError('VALIDATION', 'outbox dedupeKey is required');
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO outbox_events (
       aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at, trace_id
     ) VALUES (
       $1, $2::uuid, $3, $4::jsonb, $5, COALESCE($6::timestamptz, now()), $7
     )
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.aggregateType,
      input.aggregateId ?? null,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey,
      input.availableAt?.toISOString() ?? null,
      input.traceId ?? null,
    ],
  );
  if (result.rows[0]?.id !== undefined) {
    return { id: result.rows[0].id, created: true };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM outbox_events WHERE dedupe_key = $1`,
    [input.dedupeKey],
  );
  const id = existing.rows[0]?.id;
  if (id === undefined) {
    throw new RewardDomainError('INTERNAL', 'outbox dedupe conflict without existing row');
  }
  return { id, created: false };
}
