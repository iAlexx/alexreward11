import type { Pool, PoolClient } from 'pg';

import { ControlCenterError } from './errors.js';

type Db = Pool | PoolClient;

export const REVIEW_CASE_TYPES = [
  'WITHDRAWAL_REVIEW',
  'FRAUD_REVIEW',
  'PROVIDER_ANOMALY',
  'INVALID_TRAFFIC',
  'REFERRAL_ABUSE',
  'FOUNDER_CLAIM_ISSUE',
  'MEMBERSHIP_REASSIGNMENT',
  'SUPPORT_ESCALATION',
  'RECONCILIATION_ISSUE',
] as const;

export type ReviewCaseType = (typeof REVIEW_CASE_TYPES)[number];

export type ReviewCaseState =
  'OPEN' | 'IN_REVIEW' | 'WAITING_INPUT' | 'ESCALATED' | 'RESOLVED' | 'DISMISSED';

export interface ReviewCaseRow {
  readonly id: string;
  readonly caseType: ReviewCaseType;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly priority: string;
  readonly state: ReviewCaseState;
  readonly assignedAdminId: string | null;
  readonly summary: string | null;
  readonly resolutionNotes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
}

const LIVE_STATES: readonly ReviewCaseState[] = ['OPEN', 'IN_REVIEW', 'WAITING_INPUT', 'ESCALATED'];

function mapCase(row: {
  id: string;
  case_type: ReviewCaseType;
  resource_type: string;
  resource_id: string;
  priority: string;
  state: ReviewCaseState;
  assigned_admin_id: string | null;
  summary: string | null;
  resolution_notes: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}): ReviewCaseRow {
  return {
    id: row.id,
    caseType: row.case_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    priority: row.priority,
    state: row.state,
    assignedAdminId: row.assigned_admin_id,
    summary: row.summary,
    resolutionNotes: row.resolution_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

const CASE_SELECT = `id, case_type, resource_type, resource_id, priority, state,
  assigned_admin_id, summary, resolution_notes, created_at, updated_at, resolved_at`;

async function appendEvent(
  db: Db,
  input: {
    readonly reviewCaseId: string;
    readonly eventType: string;
    readonly adminUserId: string | null;
    readonly fromState?: ReviewCaseState | null;
    readonly toState?: ReviewCaseState | null;
    readonly note?: string | null;
    readonly payload?: Record<string, unknown>;
    readonly auditLogId?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO review_case_events (
       review_case_id, event_type, admin_user_id, from_state, to_state, note, payload, audit_log_id
     ) VALUES (
       $1::uuid, $2::review_case_event_type, $3::uuid, $4::review_case_state,
       $5::review_case_state, $6, $7::jsonb, $8::uuid
     )`,
    [
      input.reviewCaseId,
      input.eventType,
      input.adminUserId,
      input.fromState ?? null,
      input.toState ?? null,
      input.note ?? null,
      JSON.stringify(input.payload ?? {}),
      input.auditLogId ?? null,
    ],
  );
}

/** Idempotent open/ensure of one live case per case_type + resource. */
export async function ensureReviewCase(
  db: Db,
  input: {
    readonly caseType: ReviewCaseType;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly priority?: string;
    readonly summary?: string | null;
    readonly reasonCodes?: readonly string[];
    readonly adminUserId?: string | null;
  },
): Promise<ReviewCaseRow> {
  const existing = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT ${CASE_SELECT}
     FROM review_cases
     WHERE case_type = $1::review_case_type
       AND resource_type = $2
       AND resource_id = $3::uuid
       AND state = ANY($4::review_case_state[])
     ORDER BY created_at ASC
     LIMIT 1`,
    [input.caseType, input.resourceType, input.resourceId, LIVE_STATES],
  );
  if (existing.rows[0] !== undefined) {
    return mapCase(existing.rows[0]);
  }

  const inserted = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `INSERT INTO review_cases (
       case_type, resource_type, resource_id, priority, reason_codes, state, summary
     ) VALUES (
       $1::review_case_type, $2, $3::uuid, $4::priority_level, $5::text[], 'OPEN', $6
     )
     RETURNING ${CASE_SELECT}`,
    [
      input.caseType,
      input.resourceType,
      input.resourceId,
      input.priority ?? 'NORMAL',
      input.reasonCodes ?? [],
      input.summary ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('INTERNAL', undefined, {
      details: { reason: 'REVIEW_CASE_INSERT_FAILED' },
    });
  }
  await appendEvent(db, {
    reviewCaseId: row.id,
    eventType: 'CREATED',
    adminUserId: input.adminUserId ?? null,
    toState: 'OPEN',
    note: input.summary ?? null,
  });
  return mapCase(row);
}

export async function assignReviewCase(
  db: Db,
  input: {
    readonly reviewCaseId: string;
    readonly adminUserId: string;
    readonly assigneeAdminId: string;
  },
): Promise<ReviewCaseRow> {
  const updated = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `UPDATE review_cases
     SET assigned_admin_id = $2::uuid,
         state = CASE WHEN state = 'OPEN' THEN 'IN_REVIEW'::review_case_state ELSE state END,
         updated_at = now()
     WHERE id = $1::uuid
       AND state = ANY($3::review_case_state[])
     RETURNING ${CASE_SELECT}`,
    [input.reviewCaseId, input.assigneeAdminId, LIVE_STATES],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('STATE_CHANGED', undefined, {
      details: { reason: 'REVIEW_CASE_NOT_LIVE' },
    });
  }
  await appendEvent(db, {
    reviewCaseId: row.id,
    eventType: 'ASSIGNED',
    adminUserId: input.adminUserId,
    toState: row.state,
    payload: { assignedAdminId: input.assigneeAdminId },
  });
  return mapCase(row);
}

export async function commentReviewCase(
  db: Db,
  input: {
    readonly reviewCaseId: string;
    readonly adminUserId: string;
    readonly note: string;
  },
): Promise<void> {
  const note = input.note.trim();
  if (note.length < 1 || note.length > 4000) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'INVALID_NOTE' },
    });
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM review_cases WHERE id = $1::uuid`,
    [input.reviewCaseId],
  );
  if (existing.rows[0] === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'REVIEW_CASE_NOT_FOUND' },
    });
  }
  await appendEvent(db, {
    reviewCaseId: input.reviewCaseId,
    eventType: 'COMMENTED',
    adminUserId: input.adminUserId,
    note,
  });
}

export async function escalateReviewCase(
  db: Db,
  input: { readonly reviewCaseId: string; readonly adminUserId: string; readonly note?: string },
): Promise<ReviewCaseRow> {
  const current = await db.query<{ state: ReviewCaseState }>(
    `SELECT state FROM review_cases WHERE id = $1::uuid FOR UPDATE`,
    [input.reviewCaseId],
  );
  const from = current.rows[0]?.state;
  if (from === undefined || !LIVE_STATES.includes(from)) {
    throw new ControlCenterError('STATE_CHANGED');
  }
  const updated = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `UPDATE review_cases
     SET state = 'ESCALATED', updated_at = now()
     WHERE id = $1::uuid
     RETURNING ${CASE_SELECT}`,
    [input.reviewCaseId],
  );
  const row = updated.rows[0]!;
  await appendEvent(db, {
    reviewCaseId: row.id,
    eventType: 'STATE_CHANGED',
    adminUserId: input.adminUserId,
    fromState: from,
    toState: 'ESCALATED',
    note: input.note ?? null,
  });
  return mapCase(row);
}

/**
 * Resolve/dismiss only after authoritative domain success.
 * Callers must pass domainSucceeded=true only when the domain command committed.
 */
export async function resolveReviewCaseAfterDomainSuccess(
  db: Db,
  input: {
    readonly reviewCaseId: string;
    readonly adminUserId: string;
    readonly disposition: 'RESOLVED' | 'DISMISSED';
    readonly resolutionNotes?: string | null;
    readonly domainSucceeded: boolean;
    readonly actionInvoked?: string;
    readonly auditLogId?: string | null;
  },
): Promise<ReviewCaseRow> {
  if (!input.domainSucceeded) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'DOMAIN_NOT_SUCCEEDED' },
    });
  }
  const current = await db.query<{ state: ReviewCaseState }>(
    `SELECT state FROM review_cases WHERE id = $1::uuid FOR UPDATE`,
    [input.reviewCaseId],
  );
  const from = current.rows[0]?.state;
  if (from === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'REVIEW_CASE_NOT_FOUND' },
    });
  }
  if (input.actionInvoked !== undefined) {
    await appendEvent(db, {
      reviewCaseId: input.reviewCaseId,
      eventType: 'ACTION_INVOKED',
      adminUserId: input.adminUserId,
      fromState: from,
      payload: { action: input.actionInvoked },
      auditLogId: input.auditLogId ?? null,
    });
  }
  const updated = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `UPDATE review_cases
     SET state = $2::review_case_state,
         resolution_notes = $3,
         resolved_at = now(),
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING ${CASE_SELECT}`,
    [input.reviewCaseId, input.disposition, input.resolutionNotes ?? null],
  );
  const row = updated.rows[0]!;
  await appendEvent(db, {
    reviewCaseId: row.id,
    eventType: 'RESOLVED',
    adminUserId: input.adminUserId,
    fromState: from,
    toState: input.disposition,
    note: input.resolutionNotes ?? null,
    auditLogId: input.auditLogId ?? null,
  });
  return mapCase(row);
}

export async function listReviewQueue(
  db: Db,
  input?: { readonly limit?: number },
): Promise<readonly ReviewCaseRow[]> {
  const result = await db.query<{
    id: string;
    case_type: ReviewCaseType;
    resource_type: string;
    resource_id: string;
    priority: string;
    state: ReviewCaseState;
    assigned_admin_id: string | null;
    summary: string | null;
    resolution_notes: string | null;
    created_at: Date;
    updated_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT ${CASE_SELECT}
     FROM review_cases
     WHERE state = ANY($1::review_case_state[])
     ORDER BY
       CASE priority
         WHEN 'URGENT' THEN 0
         WHEN 'HIGH' THEN 1
         WHEN 'NORMAL' THEN 2
         ELSE 3
       END,
       created_at ASC
     LIMIT $2`,
    [LIVE_STATES, input?.limit ?? 100],
  );
  return result.rows.map(mapCase);
}

/**
 * Future-domain mutations (fraud Mark Safe, provider monetary, referral abuse, etc.)
 * are intentionally unavailable in Phase 8.
 */
export function assertFutureDomainMutationAvailable(_action: string): never {
  throw new ControlCenterError('ACTION_UNAVAILABLE', undefined, {
    details: { reason: 'FUTURE_DOMAIN_MUTATION_UNAVAILABLE' },
  });
}
