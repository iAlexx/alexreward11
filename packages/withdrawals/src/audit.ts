import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export interface InsertOutboxEventInput {
  readonly aggregateType: string;
  readonly aggregateId?: string | null;
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  readonly availableAt?: Date;
  readonly traceId?: string | null;
}

export async function insertWithdrawalOutboxEvent(
  client: PoolClient,
  input: InsertOutboxEventInput,
): Promise<{ id: string; created: boolean }> {
  if (input.dedupeKey.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'outbox dedupeKey is required');
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
    throw new WithdrawalDomainError('INTERNAL', 'outbox dedupe conflict without existing row');
  }
  return { id, created: false };
}

export async function insertWithdrawalAuditLog(
  client: PoolClient,
  input: {
    readonly actionType: string;
    readonly resourceType: string;
    readonly resourceId?: string | null;
    readonly afterSnapshot: Readonly<Record<string, unknown>>;
    readonly reason?: string | null;
    readonly actorType?: 'USER' | 'ADMIN' | 'SYSTEM' | 'WORKER';
    readonly adminUserId?: string | null;
    readonly traceId?: string | null;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO audit_logs (
       admin_user_id, actor_type, action_type, resource_type, resource_id,
       after_snapshot, reason, source, trace_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::jsonb, $7, 'API', $8
     )
     RETURNING id`,
    [
      input.adminUserId ?? null,
      input.actorType ?? 'USER',
      input.actionType,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.afterSnapshot),
      input.reason ?? null,
      input.traceId ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new WithdrawalDomainError('INTERNAL', 'audit log insert failed');
  }
  return id;
}
