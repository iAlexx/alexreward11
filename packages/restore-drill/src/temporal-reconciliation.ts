/**
 * Read-only Temporal visibility reconciliation for FULL_STEP2B.
 * STRICTLY FORBIDDEN: workflow.start/signal/execute/update/cancel/terminate/replay.
 */
import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';
import { hashOpaqueReference } from './user-reference.js';

export interface DbExpectedWorkflowIdentity {
  readonly withdrawalId: string;
  readonly workflowId: string;
  readonly state: string;
}

export interface TemporalReconciliationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly dbExpectedWorkflowIdentityCount: number;
  readonly temporalObservedWorkflowCount: number;
  readonly matchedCount: number;
  readonly missingInTemporalCount: number;
  readonly unexpectedInTemporalCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly mismatchReferences: readonly string[];
  readonly temporalQueried: boolean;
}

export interface TemporalListPort {
  readonly listWithdrawalWorkflowIds: () => Promise<readonly string[]>;
}

const EXPECTED_PREFIX = 'withdrawal/';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fail-closed capture of restored DB withdrawal workflow identities.
 * Requires workflow_id === `withdrawal/${withdrawal.id}` when present.
 */
export async function captureDbExpectedWorkflowIdentities(
  pool: Pool,
): Promise<
  | { readonly ok: true; readonly rows: readonly DbExpectedWorkflowIdentity[] }
  | {
      readonly ok: false;
      readonly reasonCode: string;
      readonly mismatchReferences: readonly string[];
    }
> {
  let result;
  try {
    result = await pool.query<{
      id: string;
      workflow_id: string;
      state: string;
    }>(
      `SELECT id::text AS id, workflow_id, state::text AS state
         FROM withdrawals
        WHERE workflow_id IS NOT NULL
        ORDER BY id`,
    );
  } catch {
    return { ok: false, reasonCode: 'DB_WORKFLOW_IDENTITY_QUERY_FAILED', mismatchReferences: [] };
  }

  const rows: DbExpectedWorkflowIdentity[] = [];
  const mismatchReferences: string[] = [];
  for (const row of result.rows) {
    const expected = `${EXPECTED_PREFIX}${row.id}`;
    if (row.workflow_id !== expected) {
      mismatchReferences.push(
        hashOpaqueReference('workflow-id-mismatch', `${row.id}|${row.workflow_id}`),
      );
      continue;
    }
    if (!UUID_RE.test(row.id)) {
      mismatchReferences.push(hashOpaqueReference('withdrawal-id-invalid', row.id));
      continue;
    }
    rows.push({
      withdrawalId: row.id,
      workflowId: row.workflow_id,
      state: row.state,
    });
  }
  if (mismatchReferences.length > 0) {
    return { ok: false, reasonCode: 'MALFORMED_DB_WORKFLOW_ID', mismatchReferences };
  }
  return { ok: true, rows };
}

/** Create a Temporal visibility list port using @temporalio/client (read-only list only). */
export async function createTemporalListPort(input: {
  readonly address: string;
  readonly namespace: string;
}): Promise<TemporalListPort & { readonly close: () => Promise<void> }> {
  const { Connection, Client } = await import('@temporalio/client');
  const connection = await Connection.connect({ address: input.address });
  const client = new Client({ connection, namespace: input.namespace });
  return {
    async listWithdrawalWorkflowIds() {
      const ids: string[] = [];
      const iterable = client.workflow.list({
        query: `WorkflowId STARTS_WITH "${EXPECTED_PREFIX}"`,
      });
      for await (const wf of iterable) {
        if (typeof wf.workflowId === 'string' && wf.workflowId.startsWith(EXPECTED_PREFIX)) {
          ids.push(wf.workflowId);
        }
      }
      return ids;
    },
    async close() {
      await connection.close();
    },
  };
}

export async function reconcileTemporalWorkflows(input: {
  readonly pool: Pool;
  readonly temporal: TemporalListPort | null;
}): Promise<TemporalReconciliationResult> {
  const captured = await captureDbExpectedWorkflowIdentities(input.pool);
  if (!captured.ok) {
    return {
      status: 'FAIL',
      reasonCode: captured.reasonCode,
      dbExpectedWorkflowIdentityCount: 0,
      temporalObservedWorkflowCount: 0,
      matchedCount: 0,
      missingInTemporalCount: 0,
      unexpectedInTemporalCount: 0,
      statusCounts: {},
      mismatchReferences: captured.mismatchReferences,
      temporalQueried: false,
    };
  }

  const statusCounts: Record<string, number> = {};
  for (const row of captured.rows) {
    statusCounts[row.state] = (statusCounts[row.state] ?? 0) + 1;
  }

  if (input.temporal === null) {
    return {
      status: 'FAIL',
      reasonCode: 'TEMPORAL_NOT_CONFIGURED',
      dbExpectedWorkflowIdentityCount: captured.rows.length,
      temporalObservedWorkflowCount: 0,
      matchedCount: 0,
      missingInTemporalCount: captured.rows.length,
      unexpectedInTemporalCount: 0,
      statusCounts,
      mismatchReferences: [],
      temporalQueried: false,
    };
  }

  let observed: readonly string[];
  try {
    observed = await input.temporal.listWithdrawalWorkflowIds();
  } catch {
    return {
      status: 'FAIL',
      reasonCode: 'TEMPORAL_QUERY_FAILED',
      dbExpectedWorkflowIdentityCount: captured.rows.length,
      temporalObservedWorkflowCount: 0,
      matchedCount: 0,
      missingInTemporalCount: captured.rows.length,
      unexpectedInTemporalCount: 0,
      statusCounts,
      mismatchReferences: [],
      temporalQueried: false,
    };
  }

  const expectedSet = new Set(captured.rows.map((r) => r.workflowId));
  const observedSet = new Set(observed);
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const id of expectedSet) {
    if (!observedSet.has(id)) missing.push(id);
  }
  for (const id of observedSet) {
    if (!expectedSet.has(id)) unexpected.push(id);
  }

  const matchedCount = expectedSet.size - missing.length;
  const mismatchReferences = [
    ...missing.map((id) => hashOpaqueReference('missing-in-temporal', id)),
    ...unexpected.map((id) => hashOpaqueReference('unexpected-in-temporal', id)),
  ];

  if (captured.rows.length === 0 && observed.length === 0) {
    return {
      status: 'PASS',
      reasonCode: 'NO_WITHDRAWAL_WORKFLOWS_TO_RECONCILE',
      dbExpectedWorkflowIdentityCount: 0,
      temporalObservedWorkflowCount: 0,
      matchedCount: 0,
      missingInTemporalCount: 0,
      unexpectedInTemporalCount: 0,
      statusCounts,
      mismatchReferences: [],
      temporalQueried: true,
    };
  }

  if (missing.length > 0 || unexpected.length > 0) {
    return {
      status: 'OWNER_REVIEW_REQUIRED',
      reasonCode:
        missing.length > 0 ? 'TEMPORAL_MISSING_EXPECTED' : 'TEMPORAL_UNEXPECTED_WORKFLOW',
      dbExpectedWorkflowIdentityCount: captured.rows.length,
      temporalObservedWorkflowCount: observed.length,
      matchedCount,
      missingInTemporalCount: missing.length,
      unexpectedInTemporalCount: unexpected.length,
      statusCounts,
      mismatchReferences,
      temporalQueried: true,
    };
  }

  return {
    status: 'PASS',
    reasonCode: 'TEMPORAL_WORKFLOW_SETS_MATCH',
    dbExpectedWorkflowIdentityCount: captured.rows.length,
    temporalObservedWorkflowCount: observed.length,
    matchedCount,
    missingInTemporalCount: 0,
    unexpectedInTemporalCount: 0,
    statusCounts,
    mismatchReferences: [],
    temporalQueried: true,
  };
}