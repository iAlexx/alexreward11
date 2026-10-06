import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
  buildPhase21PayoutConfig,
  processWithdrawalPhase21ManualDispatchOutboxBatch,
  tryBuildPhase21ManualDispatchRelayAuthority,
  withdrawalWorkflowId,
  type Phase21ManualDispatchRelayAuthority,
  type TemporalWorkflowStarter,
} from '../src/index.js';

const WID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EVENT_ID2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PERMIT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ATTEMPT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown>;

type EvidenceRow = {
  attempt_count: number;
  signature_evidence: number;
  submitted: number;
  chain_ref: number;
  ambiguous: number;
  confirmed: number;
  failed_pre_only: number;
};

type OutboxEventState = {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  available_at: Date;
  status: 'PENDING' | 'DISPATCHED' | 'DEAD_LETTER';
  last_error_redacted: string | null;
};

function zeroEvidence(): EvidenceRow {
  return {
    attempt_count: 0,
    signature_evidence: 0,
    submitted: 0,
    chain_ref: 0,
    ambiguous: 0,
    confirmed: 0,
    failed_pre_only: 0,
  };
}

function makePermitRow(input: {
  withdrawalId: string;
  status: 'ARMED' | 'CONSUMED' | 'CANCELLED';
  consumedAttemptId?: string | null;
}): Row {
  return {
    id: PERMIT_ID,
    withdrawal_id: input.withdrawalId,
    public_id: 'p21-canary',
    authorized_gross_atomic: '1000000',
    authorized_fee_atomic: '0',
    authorized_net_atomic: '1000000',
    authorized_recipient_friendly: 'EQ_recipient',
    authorized_recipient_raw: '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    authorized_network_code: 'TON_MAINNET',
    authorized_asset_symbol: 'USDT',
    authorized_jetton_master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    authorized_attached_gram_atomic: '50000000',
    authorized_forward_gram_atomic: '1',
    status: input.status,
    consumed_attempt_id: input.consumedAttemptId ?? null,
    created_by_admin_user_id: '11111111-1111-4111-8111-111111111111',
    created_at: new Date('2026-10-06T00:00:00.000Z'),
    consumed_at: input.status === 'CONSUMED' ? new Date('2026-10-06T00:01:00.000Z') : null,
    cancelled_at: input.status === 'CANCELLED' ? new Date('2026-10-06T00:02:00.000Z') : null,
    cancel_reason: input.status === 'CANCELLED' ? 'owner_cancel' : null,
    idempotency_key: `phase21.manual_dispatch.canary:${input.withdrawalId}`,
    audit_correlation_id: null,
  };
}

function makeOutboxEvent(input: {
  id: string;
  withdrawalId: string;
}): OutboxEventState {
  return {
    id: input.id,
    aggregate_id: input.withdrawalId,
    event_type: WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
    payload: {
      withdrawalId: input.withdrawalId,
      workflowId: withdrawalWorkflowId(input.withdrawalId),
      permitId: PERMIT_ID,
      phase21ManualDispatch: true,
    },
    attempts: 0,
    available_at: new Date('2020-01-01T00:00:00.000Z'),
    status: 'PENDING',
    last_error_redacted: null,
  };
}

function buildValidAuthority(): Phase21ManualDispatchRelayAuthority {
  const phase21 = buildPhase21PayoutConfig({
    phase21MainnetEnabled: true,
    realChainEnabled: true,
    fakeChainEnabled: false,
    signerServiceToken: 'x'.repeat(32),
    primaryProviderKind: 'toncenter',
    primaryProviderUrl: 'https://toncenter.com/api/v2',
    secondaryProviderKind: 'tonapi',
    secondaryProviderUrl: 'https://tonapi.io',
    jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
    signerBaseUrl: 'https://signer.example.internal',
  });
  const authority = tryBuildPhase21ManualDispatchRelayAuthority({
    payoutAuthority: 'PHASE21_MAINNET',
    phase21MainnetEnabled: true,
    withdrawalNetworkCode: 'TON_MAINNET',
    realChainEnabled: true,
    fakeChainEnabled: false,
    phase21,
  });
  if (authority === null) {
    throw new Error('expected valid Phase21 Mainnet authority');
  }
  return authority;
}

type BoundAttemptRow = {
  id: string;
  withdrawal_id: string;
  broadcast_result_state: string;
  signed_external_message_boc?: string | null;
  signed_wallet_request_boc?: string | null;
  external_message_cell_hash?: string | null;
  normalized_external_message_hash?: string | null;
  signed_message_hash?: string | null;
  broadcast_submitted_at?: Date | null;
  chain_reference?: string | null;
  withdrawal_state?: string;
};

function makeMockPool(state: {
  events: OutboxEventState[];
  permits: Row[];
  evidenceByWithdrawal: Record<string, EvidenceRow>;
  boundAttempts?: BoundAttemptRow[];
}): {
  pool: Pool;
  client: PoolClient;
} {
  const client = {
    async query(text: string, params?: readonly unknown[]) {
      const sql = text.replace(/\s+/g, ' ');

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (
        sql.includes('FROM outbox_events') &&
        sql.includes('FOR UPDATE SKIP LOCKED') &&
        sql.includes('event_type = $1')
      ) {
        const eventType = String(params?.[0]);
        const limit = Number(params?.[1] ?? 20);
        const claimed = state.events
          .filter(
            (e) =>
              e.event_type === eventType &&
              e.status === 'PENDING' &&
              e.available_at.getTime() <= Date.now(),
          )
          .slice(0, limit)
          .map((e) => ({
            id: e.id,
            aggregate_id: e.aggregate_id,
            event_type: e.event_type,
            payload: e.payload,
            attempts: e.attempts,
            available_at: e.available_at,
          }));
        return { rows: claimed };
      }

      if (
        sql.includes('FROM phase21_manual_dispatch_permits') &&
        sql.includes('WHERE withdrawal_id')
      ) {
        const withdrawalId = String(params?.[0]);
        const row = state.permits.find((p) => p.withdrawal_id === withdrawalId);
        return { rows: row ? [row] : [] };
      }

      if (
        sql.includes('FROM withdrawal_attempts a') &&
        sql.includes('JOIN withdrawals w') &&
        sql.includes('WHERE a.id')
      ) {
        const attemptId = String(params?.[0]);
        const rows = (state.boundAttempts ?? []).filter((a) => a.id === attemptId);
        return {
          rows: rows.map((a) => ({
            id: a.id,
            withdrawal_id: a.withdrawal_id,
            broadcast_result_state: a.broadcast_result_state,
            signed_external_message_boc: a.signed_external_message_boc ?? null,
            signed_wallet_request_boc: a.signed_wallet_request_boc ?? null,
            external_message_cell_hash: a.external_message_cell_hash ?? null,
            normalized_external_message_hash: a.normalized_external_message_hash ?? null,
            signed_message_hash: a.signed_message_hash ?? null,
            broadcast_submitted_at: a.broadcast_submitted_at ?? null,
            chain_reference: a.chain_reference ?? null,
            withdrawal_state: a.withdrawal_state ?? 'APPROVED',
          })),
        };
      }

      if (
        sql.includes('FROM withdrawal_attempts') &&
        sql.includes('AS attempt_count') &&
        sql.includes('WHERE withdrawal_id')
      ) {
        const withdrawalId = String(params?.[0]);
        const evidence = state.evidenceByWithdrawal[withdrawalId] ?? zeroEvidence();
        return { rows: [evidence] };
      }

      if (sql.includes("SET status = 'DISPATCHED'")) {
        const id = String(params?.[0]);
        const event = state.events.find((e) => e.id === id);
        if (event) {
          event.status = 'DISPATCHED';
          event.last_error_redacted = null;
        }
        return { rows: [] };
      }

      if (sql.includes("SET status = 'DEAD_LETTER'")) {
        const id = String(params?.[0]);
        const err = String(params?.[1] ?? '');
        const event = state.events.find((e) => e.id === id && e.status === 'PENDING');
        if (event) {
          event.status = 'DEAD_LETTER';
          event.last_error_redacted = err;
          event.attempts += 1;
        }
        return { rows: [] };
      }

      if (sql.includes('SET attempts = attempts + 1') && sql.includes('available_at = now()')) {
        const id = String(params?.[0]);
        const err = String(params?.[1] ?? '');
        const event = state.events.find((e) => e.id === id && e.status === 'PENDING');
        if (event) {
          event.attempts += 1;
          event.last_error_redacted = err;
          event.available_at = new Date(Date.now() + 60_000);
        }
        return { rows: [] };
      }

      throw new Error(`unexpected SQL: ${sql.slice(0, 160)}`);
    },
    release() {
      // no-op
    },
  } as unknown as PoolClient;

  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;

  return { pool, client };
}

function recordingStarter(input?: {
  readonly throwAlreadyStartedOn?: number;
  readonly throwGenericOn?: number;
  readonly runningDescribe?: boolean;
  readonly priorStatus?: string;
}): TemporalWorkflowStarter & {
  readonly starts: Array<{
    workflowId: string;
    reusePolicy: string | undefined;
    realChainEnabled: boolean | undefined;
    args: unknown;
  }>;
} {
  const starts: Array<{
    workflowId: string;
    reusePolicy: string | undefined;
    realChainEnabled: boolean | undefined;
    args: unknown;
  }> = [];
  let startCount = 0;
  return {
    starts,
    workflow: {
      async start(_type, options) {
        startCount += 1;
        const arg0 = options.args[0] as { withdrawalId: string; realChainEnabled?: boolean };
        starts.push({
          workflowId: options.workflowId,
          reusePolicy: options.workflowIdReusePolicy,
          realChainEnabled: arg0.realChainEnabled,
          args: options.args,
        });
        if (input?.throwGenericOn !== undefined && startCount === input.throwGenericOn) {
          throw new Error('temporal_unavailable');
        }
        if (
          input?.throwAlreadyStartedOn !== undefined &&
          startCount === input.throwAlreadyStartedOn
        ) {
          throw new WorkflowExecutionAlreadyStartedError(
            'already started',
            options.workflowId,
            WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
          );
        }
        return {};
      },
      getHandle(workflowId: string) {
        return {
          async describe() {
            void workflowId;
            if (input?.runningDescribe === true) {
              return { status: { name: 'RUNNING' } };
            }
            return { status: { name: input?.priorStatus ?? 'COMPLETED' } };
          },
        };
      },
    },
  };
}

describe('phase21 manual dispatch outbox relay fail-closed', () => {
  it('authority null → DEAD_LETTER phase21_mainnet_relay_authority_not_ready, no Temporal start', async () => {
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority: null,
    });
    expect(batch).toEqual({ claimed: 1, dispatched: 0, retried: 0, deadLetter: 1 });
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.status).toBe('DEAD_LETTER');
    expect(state.events[0]!.last_error_redacted).toContain(
      'phase21_mainnet_relay_authority_not_ready',
    );
  });

  it('realChain false / fakeChain / Testnet / missing Phase21 config → null authority, no start', () => {
    const phase21 = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      signerServiceToken: 'x'.repeat(32),
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://tonapi.io',
      jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
      signerBaseUrl: 'https://signer.example.internal',
    });
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({
        payoutAuthority: 'PHASE21_MAINNET',
        phase21MainnetEnabled: true,
        withdrawalNetworkCode: 'TON_MAINNET',
        realChainEnabled: false,
        fakeChainEnabled: false,
        phase21,
      }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({
        payoutAuthority: 'PHASE21_MAINNET',
        phase21MainnetEnabled: true,
        withdrawalNetworkCode: 'TON_MAINNET',
        realChainEnabled: true,
        fakeChainEnabled: true,
        phase21,
      }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({
        payoutAuthority: 'PHASE10_TESTNET',
        phase21MainnetEnabled: true,
        withdrawalNetworkCode: 'TON_TESTNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        phase21,
      }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({
        payoutAuthority: 'PHASE21_MAINNET',
        phase21MainnetEnabled: true,
        withdrawalNetworkCode: 'TON_MAINNET',
        realChainEnabled: true,
        fakeChainEnabled: false,
        phase21: null,
      }),
    ).toBeNull();
  });

  it('exact validated Phase21 Mainnet authority + ARMED + 0 attempts → ALLOW_DUPLICATE start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ priorStatus: 'COMPLETED' });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq-phase21',
      authority,
    });
    expect(batch).toEqual({ claimed: 1, dispatched: 1, retried: 0, deadLetter: 0 });
    expect(starter.starts).toHaveLength(1);
    expect(starter.starts[0]).toMatchObject({
      workflowId: withdrawalWorkflowId(WID),
      reusePolicy: 'ALLOW_DUPLICATE',
      realChainEnabled: true,
    });
    expect(state.events[0]!.status).toBe('DISPATCHED');
  });

  it('missing permit → dead letter missing_permit, no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [] as Row[],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('missing_permit');
  });

  it('CANCELLED permit → dead letter cancelled_permit, no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'CANCELLED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('cancelled_permit');
  });

  it('ARMED permit + existing attempts → dead letter armed_with_attempts', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1 },
      },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('armed_with_attempts');
  });

  it('CONSUMED bound same attempt resume-safe → start allowed', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1, failed_pre_only: 0 },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'PENDING',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ priorStatus: 'COMPLETED' });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.dispatched).toBe(1);
    expect(starter.starts).toHaveLength(1);
    expect(starter.starts[0]!.reusePolicy).toBe('ALLOW_DUPLICATE');
  });

  it('CONSUMED failed_pre → restart safety refuses, no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1, failed_pre_only: 1 },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'FAILED_PRE_BROADCAST',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain(
      'consumed_failed_pre_use_owner_gated_retry',
    );
  });


  it('restart safety: missing bound attempt → missing_bound_attempt', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
      boundAttempts: [],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('missing_bound_attempt');
  });

  it('restart safety: bound attempt wrong withdrawal → refuse', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID2,
          broadcast_result_state: 'PENDING',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(state.events[0]!.last_error_redacted).toContain('bound_attempt_wrong_withdrawal');
  });

  it('wrong withdrawal (permit on other id) → missing_permit, no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID2, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('missing_permit');
  });

  it('duplicate poll / AlreadyStarted → DISPATCHED', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ throwAlreadyStartedOn: 1 });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.dispatched).toBe(1);
    expect(batch.deadLetter).toBe(0);
    expect(state.events[0]!.status).toBe('DISPATCHED');
  });

  it('crash after Temporal start before DISPATCHED: RUNNING → DISPATCHED, no second start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ runningDescribe: true });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch).toEqual({ claimed: 1, dispatched: 1, retried: 0, deadLetter: 0 });
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.status).toBe('DISPATCHED');
  });

  it('prior workflow closed before attempt + ARMED → ALLOW_DUPLICATE start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ priorStatus: 'COMPLETED' });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.dispatched).toBe(1);
    expect(starter.starts).toHaveLength(1);
    expect(starter.starts[0]!.reusePolicy).toBe('ALLOW_DUPLICATE');
  });

  it('prior closed with existing attempt + broadcast evidence → no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: {
          ...zeroEvidence(),
          attempt_count: 1,
          submitted: 1,
          chain_ref: 1,
        },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'PENDING',
          broadcast_submitted_at: new Date('2026-10-06T00:02:00.000Z'),
          chain_reference: 'msg-hash',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ priorStatus: 'COMPLETED' });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('reconcile_required_no_restart');
  });

  it('prior CONFIRMED → no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1, confirmed: 1 },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'PENDING',
          withdrawal_state: 'CONFIRMED',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('reconcile_required_no_restart');
  });

  it('prior RECONCILE_REQUIRED → no start', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1, ambiguous: 1 },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'RECONCILE_REQUIRED',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('reconcile_required_no_restart');
  });

  it('prior FAILED_PRE_BROADCAST → no start (owner-gated path)', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: ATTEMPT_ID,
        }),
      ],
      evidenceByWithdrawal: {
        [WID]: { ...zeroEvidence(), attempt_count: 1, failed_pre_only: 1 },
      },
      boundAttempts: [
        {
          id: ATTEMPT_ID,
          withdrawal_id: WID,
          broadcast_result_state: 'FAILED_PRE_BROADCAST',
        },
      ],
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
  });

  it('Temporal start failure → markOutboxRetry, stays PENDING', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ throwGenericOn: 1 });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch).toEqual({ claimed: 1, dispatched: 0, retried: 1, deadLetter: 0 });
    expect(state.events[0]!.status).toBe('PENDING');
    expect(state.events[0]!.attempts).toBe(1);
    expect(state.events[0]!.last_error_redacted).toContain('temporal_unavailable');
  });

  it('one permit cannot authorize a second withdrawal event', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [
        makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID }),
        makeOutboxEvent({ id: EVENT_ID2, withdrawalId: WID2 }),
      ],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: {
        [WID]: zeroEvidence(),
        [WID2]: zeroEvidence(),
      },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter({ priorStatus: 'COMPLETED' });
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
      limit: 20,
    });
    expect(batch.claimed).toBe(2);
    expect(batch.dispatched).toBe(1);
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(1);
    expect(starter.starts[0]!.workflowId).toBe(withdrawalWorkflowId(WID));
    expect(state.events[0]!.status).toBe('DISPATCHED');
    expect(state.events[1]!.status).toBe('DEAD_LETTER');
    expect(state.events[1]!.last_error_redacted).toContain('missing_permit');
  });

  it('CONSUMED unbound → dead letter consumed_unbound', async () => {
    const authority = buildValidAuthority();
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [
        makePermitRow({
          withdrawalId: WID,
          status: 'CONSUMED',
          consumedAttemptId: null,
        }),
      ],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    const batch = await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(batch.deadLetter).toBe(1);
    expect(starter.starts).toHaveLength(0);
    expect(state.events[0]!.last_error_redacted).toContain('consumed_unbound');
  });

  it('never starts with realChainEnabled false even when Temporal is called', async () => {
    const authority = buildValidAuthority();
    expect(authority.realChainEnabled).toBe(true);
    expect(authority.fakeChainEnabled).toBe(false);
    const state = {
      events: [makeOutboxEvent({ id: EVENT_ID, withdrawalId: WID })],
      permits: [makePermitRow({ withdrawalId: WID, status: 'ARMED' })],
      evidenceByWithdrawal: { [WID]: zeroEvidence() },
    };
    const { pool } = makeMockPool(state);
    const starter = recordingStarter();
    await processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
      client: starter,
      taskQueue: 'tq',
      authority,
    });
    expect(starter.starts[0]!.realChainEnabled).toBe(true);
  });

  it('Mainnet authority fails closed when fakeChainEnabled is undefined or null', () => {
    const valid = buildValidAuthority();
    const base = {
      payoutAuthority: 'PHASE21_MAINNET' as const,
      phase21MainnetEnabled: true,
      withdrawalNetworkCode: 'TON_MAINNET',
      realChainEnabled: true,
      phase21: valid.phase21,
    };
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: false }),
    ).not.toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: true }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base }),
    ).toBeNull();
    expect(
      tryBuildPhase21ManualDispatchRelayAuthority({ ...base, fakeChainEnabled: null }),
    ).toBeNull();
  });

});

