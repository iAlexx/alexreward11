/**
 * Canonical Phase 10 historical baseline snapshot (read-only DB capture).
 * Captured BEFORE live authorization. Never uses hardcoded public IDs.
 * Never auto-resends or mutates financial state.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';
import { WITHDRAWAL_APPROVED_OUTBOX_EVENT } from './outbox.js';
import type {
  Phase10HistoricalBaselineAttemptState,
  Phase10HistoricalBaselineInput,
} from './phase10-restore-reconcile.js';

export const PHASE10_HISTORICAL_BASELINE_SCHEMA_VERSION = 1 as const;

export interface Phase10HistoricalBaselineAttemptSnapshot {
  readonly attemptId: string;
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

export interface Phase10HistoricalBaselineArtifact {
  readonly schemaVersion: typeof PHASE10_HISTORICAL_BASELINE_SCHEMA_VERSION;
  /** Tool-generated capture timestamp — never caller-manufactured in production. */
  readonly capturedAt: string;
  readonly attempts: readonly Phase10HistoricalBaselineAttemptSnapshot[];
  /** SHA-256 over capturedAt + all safety-relevant snapshot fields (no secrets). */
  readonly evidenceDigest: string;
}

export function digestPhase10HistoricalBaseline(
  capturedAt: string,
  attempts: readonly Phase10HistoricalBaselineAttemptSnapshot[],
): string {
  const payload = [
    `capturedAt=${capturedAt}`,
    ...attempts
      .map((a) =>
        [
          a.attemptId,
          a.withdrawalId,
          a.broadcastResultState,
          a.broadcastSubmittedAt ?? '',
          a.ambiguityClass ?? '',
          a.withdrawalState,
          a.approvedOutboxStatus ?? '',
          a.workflowId ?? '',
          String(a.newerAttemptLineageCount),
          a.hasPendingApprovedOutbox ? '1' : '0',
        ].join('|'),
      )
      .sort(),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
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

async function queryBaselineAttempts(
  client: PoolClient,
): Promise<Phase10HistoricalBaselineAttemptSnapshot[]> {
  const rows = await client.query<{
    attempt_id: string;
    withdrawal_id: string;
    broadcast_result_state: string;
    broadcast_submitted_at: Date | null;
    ambiguity_class: string | null;
    withdrawal_state: string;
    workflow_id: string | null;
    approved_outbox_status: string | null;
    newer_attempt_count: number;
    has_pending_outbox: boolean;
  }>(
    `SELECT a.id AS attempt_id,
            a.withdrawal_id,
            a.broadcast_result_state::text AS broadcast_result_state,
            a.broadcast_submitted_at,
            a.broadcast_ambiguity_class AS ambiguity_class,
            w.state::text AS withdrawal_state,
            w.workflow_id,
            (
              SELECT o.status::text FROM outbox_events o
              WHERE o.event_type = $1
                AND (o.aggregate_id = a.withdrawal_id
                     OR (o.payload->>'withdrawalId') = a.withdrawal_id::text)
              ORDER BY CASE WHEN o.status = 'PENDING' THEN 0 ELSE 1 END, o.created_at DESC
              LIMIT 1
            ) AS approved_outbox_status,
            (
              SELECT count(*)::int FROM withdrawal_attempts a2
              WHERE a2.withdrawal_id = a.withdrawal_id
                AND a2.id <> a.id
                AND a2.created_at > a.created_at
            ) AS newer_attempt_count,
            EXISTS (
              SELECT 1 FROM outbox_events o
              WHERE o.event_type = $1
                AND o.status = 'PENDING'
                AND (o.aggregate_id = a.withdrawal_id
                     OR (o.payload->>'withdrawalId') = a.withdrawal_id::text)
            ) AS has_pending_outbox
     FROM withdrawal_attempts a
     JOIN withdrawals w ON w.id = a.withdrawal_id
     WHERE a.broadcast_submitted_at IS NOT NULL
       AND a.broadcast_result_state IN ('UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED', 'PENDING')
       AND w.state NOT IN ('CONFIRMED', 'REJECTED', 'FAILED_PRE_BROADCAST')
     ORDER BY a.id ASC`,
    [WITHDRAWAL_APPROVED_OUTBOX_EVENT],
  );

  return rows.rows.map((row) => ({
    attemptId: row.attempt_id,
    withdrawalId: row.withdrawal_id,
    broadcastResultState: row.broadcast_result_state,
    broadcastSubmittedAt: row.broadcast_submitted_at
      ? row.broadcast_submitted_at.toISOString()
      : null,
    ambiguityClass: row.ambiguity_class,
    withdrawalState: row.withdrawal_state,
    approvedOutboxStatus: row.approved_outbox_status,
    workflowId: row.workflow_id,
    newerAttemptLineageCount: row.newer_attempt_count,
    hasPendingApprovedOutbox: row.has_pending_outbox === true,
  }));
}

/**
 * Read-only production capture of currently ambiguous / submitted-unknown attempts.
 * Always generates capturedAt internally. Does not accept a caller timestamp.
 */
export async function capturePhase10HistoricalBaseline(
  db: Pool | PoolClient,
): Promise<Phase10HistoricalBaselineArtifact> {
  return withClient(db, async (client) => {
    const capturedAt = new Date().toISOString();
    const attempts = await queryBaselineAttempts(client);
    return {
      schemaVersion: PHASE10_HISTORICAL_BASELINE_SCHEMA_VERSION,
      capturedAt,
      attempts,
      evidenceDigest: digestPhase10HistoricalBaseline(capturedAt, attempts),
    };
  });
}

/**
 * INTERNAL test helper — not re-exported from package index.
 * Allows deterministic capturedAt via fake timers or explicit ISO for unit tests only.
 */
export async function capturePhase10HistoricalBaselineForTests(
  db: Pool | PoolClient,
  capturedAt: string,
): Promise<Phase10HistoricalBaselineArtifact> {
  return withClient(db, async (client) => {
    const attempts = await queryBaselineAttempts(client);
    return {
      schemaVersion: PHASE10_HISTORICAL_BASELINE_SCHEMA_VERSION,
      capturedAt,
      attempts,
      evidenceDigest: digestPhase10HistoricalBaseline(capturedAt, attempts),
    };
  });
}

export function parsePhase10HistoricalBaseline(raw: unknown): {
  readonly errors: readonly string[];
  readonly parsed: Phase10HistoricalBaselineArtifact | null;
} {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['historical baseline is not a JSON object'], parsed: null };
  }
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    errors.push('historical baseline schemaVersion must be 1');
  }
  if (typeof root.capturedAt !== 'string' || root.capturedAt.trim() === '') {
    errors.push('historical baseline missing tool-generated capturedAt');
  } else if (!Number.isFinite(Date.parse(root.capturedAt))) {
    errors.push('historical baseline capturedAt is not a valid ISO timestamp');
  }
  if (!Array.isArray(root.attempts)) {
    errors.push('historical baseline missing attempts array');
  }
  if (typeof root.evidenceDigest !== 'string' || root.evidenceDigest.trim() === '') {
    errors.push('historical baseline missing evidenceDigest');
  }

  if (errors.length > 0 || !Array.isArray(root.attempts)) {
    return { errors, parsed: null };
  }

  const attempts: Phase10HistoricalBaselineAttemptSnapshot[] = [];
  for (const row of root.attempts) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push('historical baseline attempt row malformed');
      continue;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.attemptId !== 'string' || r.attemptId.trim() === '') {
      errors.push('historical baseline attempt missing attemptId');
      continue;
    }
    if (typeof r.withdrawalId !== 'string' || r.withdrawalId.trim() === '') {
      errors.push(`historical baseline attempt ${r.attemptId} missing withdrawalId`);
      continue;
    }
    if (typeof r.broadcastResultState !== 'string' || r.broadcastResultState.trim() === '') {
      errors.push(`historical baseline attempt ${r.attemptId} missing broadcastResultState`);
      continue;
    }
    if (typeof r.withdrawalState !== 'string' || r.withdrawalState.trim() === '') {
      errors.push(`historical baseline attempt ${r.attemptId} missing withdrawalState`);
      continue;
    }
    if (
      typeof r.newerAttemptLineageCount !== 'number' ||
      !Number.isFinite(r.newerAttemptLineageCount)
    ) {
      errors.push(`historical baseline attempt ${r.attemptId} missing newerAttemptLineageCount`);
      continue;
    }
    attempts.push({
      attemptId: r.attemptId,
      withdrawalId: r.withdrawalId,
      broadcastResultState: r.broadcastResultState,
      broadcastSubmittedAt:
        typeof r.broadcastSubmittedAt === 'string' ? r.broadcastSubmittedAt : null,
      ambiguityClass: typeof r.ambiguityClass === 'string' ? r.ambiguityClass : null,
      withdrawalState: r.withdrawalState,
      approvedOutboxStatus:
        typeof r.approvedOutboxStatus === 'string' ? r.approvedOutboxStatus : null,
      workflowId: typeof r.workflowId === 'string' ? r.workflowId : null,
      newerAttemptLineageCount: r.newerAttemptLineageCount,
      hasPendingApprovedOutbox: r.hasPendingApprovedOutbox === true,
    });
  }

  if (errors.length > 0) {
    return { errors, parsed: null };
  }

  const capturedAt = (root.capturedAt as string).trim();
  const expectedDigest = digestPhase10HistoricalBaseline(capturedAt, attempts);
  if (root.evidenceDigest !== expectedDigest) {
    return {
      errors: ['historical baseline evidenceDigest mismatch (snapshot tampered or incomplete)'],
      parsed: null,
    };
  }

  return {
    errors: [],
    parsed: {
      schemaVersion: 1,
      capturedAt,
      attempts,
      evidenceDigest: expectedDigest,
    },
  };
}

export async function writePhase10HistoricalBaseline(
  path: string,
  artifact: Phase10HistoricalBaselineArtifact,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export async function readPhase10HistoricalBaseline(path: string): Promise<{
  readonly errors: readonly string[];
  readonly parsed: Phase10HistoricalBaselineArtifact | null;
}> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsePhase10HistoricalBaseline(raw);
  } catch (error) {
    return {
      errors: [
        `historical baseline missing or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      parsed: null,
    };
  }
}

/**
 * Convert a validated canonical baseline artifact into restore-scan input.
 * Carries the full safety-relevant snapshot for each attempt.
 */
export function historicalBaselineInputFromArtifact(
  artifact: Phase10HistoricalBaselineArtifact,
): Phase10HistoricalBaselineInput {
  const attemptStates: Record<string, Phase10HistoricalBaselineAttemptState> = {};
  for (const attempt of artifact.attempts) {
    attemptStates[attempt.attemptId] = {
      withdrawalId: attempt.withdrawalId,
      broadcastResultState: attempt.broadcastResultState,
      broadcastSubmittedAt: attempt.broadcastSubmittedAt,
      ambiguityClass: attempt.ambiguityClass,
      withdrawalState: attempt.withdrawalState,
      approvedOutboxStatus: attempt.approvedOutboxStatus,
      workflowId: attempt.workflowId,
      newerAttemptLineageCount: attempt.newerAttemptLineageCount,
      hasPendingApprovedOutbox: attempt.hasPendingApprovedOutbox,
    };
  }
  return {
    attemptIds: artifact.attempts.map((a) => a.attemptId),
    capturedAt: artifact.capturedAt,
    attemptStates,
    artifactDigest: artifact.evidenceDigest,
    requireCanonicalArtifact: true,
  };
}
