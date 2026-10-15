/**
 * In-memory SQL-pattern mock of the Phase 21 Gen-4 world (no PostgreSQL required).
 *
 * Models WD-000001 after Gen-1/2/3: three FAILED_PRE attempts with zero evidence,
 * Gen-1/2/3 CONSUMED permits, the durable Gen-2 + Gen-3 Temporal launch claims and a
 * Gen-4 permit. Used by Gen-4 PLAN / APPLY / Temporal-claim unit tests. Every query is
 * logged so tests can assert FOR UPDATE ordering.
 */
import { vi } from 'vitest';

import { PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS } from '../src/phase21-canary-payout-apply.js';
import {
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
} from '../src/phase21-canary-payout-plan.js';
import { PHASE21_NETWORK_CODE } from '../src/phase21-config.js';
import {
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen2-temporal-launch.js';
import {
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen3-temporal-launch.js';
import { phase21ManualDispatchGenerationIdempotencyKey } from '../src/phase21-manual-dispatch-permit.js';
import { withdrawalWorkflowId } from '../src/outbox.js';

export const WID = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
export const GEN1_PERMIT_ID = '11111111-1111-4111-8111-111111111111';
export const GEN2_PERMIT_ID = '22222222-2222-4222-8222-222222222222';
export const GEN3_PERMIT_ID = '33333333-3333-4333-8333-333333333333';
export const GEN4_PERMIT_ID = '44444444-4444-4444-8444-444444444444';
export const OTHER_PERMIT_ID = '99999999-9999-4999-8999-999999999999';
export const ATTEMPT_IDS = ['attempt-1', 'attempt-2', 'attempt-3'] as const;
/** DB query ids; equal to the defaults minted by mintPhase21Gen4IndependentChainReconciliationForTests. */
export const DB_QUERY_IDS = ['900000000001', '900000000002', '900000000003'] as const;
export const ADMIN_ID = '55555555-5555-4555-8555-555555555555';

export interface MockPermit {
  id: string;
  generation: number;
  status: 'ARMED' | 'CONSUMED' | 'CANCELLED';
  consumedAttemptId: string | null;
  withdrawalId: string;
}

export interface MockAttempt {
  id: string;
  attemptNumber: number;
  state: string;
  hasEvidence: boolean;
  queryId: string | null;
}

export interface MockOutboxRow {
  id: string;
  eventType: string;
  status: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: unknown;
}

export interface Gen4MockWorld {
  withdrawalId: string;
  publicId: string;
  state: string;
  reservation: string | null;
  settlement: string | null;
  release: string | null;
  paused: boolean;
  permits: MockPermit[];
  attempts: MockAttempt[];
  outbox: Map<string, MockOutboxRow>;
  log: string[];
}

export function gen3ClaimPayload(
  overrides?: Partial<Record<string, unknown>>,
  ids?: { withdrawalId?: string; gen3PermitId?: string },
): Record<string, unknown> {
  const withdrawalId = ids?.withdrawalId ?? WID;
  return {
    withdrawalId,
    gen3PermitId: ids?.gen3PermitId ?? GEN3_PERMIT_ID,
    expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
    identityMode: 'durable_gen2_terminal',
    workflowId: withdrawalWorkflowId(withdrawalId),
    authorizationGeneration: 3,
    broadcastPerformed: false,
    signed: false,
    ...overrides,
  };
}

export function createGen4World(options?: {
  /** 'absent' = fresh pre-APPLY state (PLAN/APPLY tests); default ARMED (Temporal tests). */
  readonly gen4?: 'ARMED' | 'absent';
  readonly withGen2Claim?: boolean;
  readonly withGen3Claim?: boolean;
}): Gen4MockWorld {
  const world: Gen4MockWorld = {
    withdrawalId: WID,
    publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
    state: 'FAILED_PRE_BROADCAST',
    reservation: 'res-1',
    settlement: null,
    release: null,
    paused: true,
    permits: [
      { id: GEN1_PERMIT_ID, generation: 1, status: 'CONSUMED', consumedAttemptId: ATTEMPT_IDS[0], withdrawalId: WID },
      { id: GEN2_PERMIT_ID, generation: 2, status: 'CONSUMED', consumedAttemptId: ATTEMPT_IDS[1], withdrawalId: WID },
      { id: GEN3_PERMIT_ID, generation: 3, status: 'CONSUMED', consumedAttemptId: ATTEMPT_IDS[2], withdrawalId: WID },
    ],
    attempts: [1, 2, 3].map((n) => ({
      id: ATTEMPT_IDS[n - 1]!,
      attemptNumber: n,
      state: 'FAILED_PRE_BROADCAST',
      hasEvidence: false,
      queryId: DB_QUERY_IDS[n - 1]!,
    })),
    outbox: new Map(),
    log: [],
  };
  if ((options?.gen4 ?? 'ARMED') === 'ARMED') {
    world.permits.push({
      id: GEN4_PERMIT_ID,
      generation: 4,
      status: 'ARMED',
      consumedAttemptId: null,
      withdrawalId: WID,
    });
  }
  if (options?.withGen2Claim !== false) {
    world.outbox.set(
      buildPhase21Gen2TemporalLaunchClaimDedupeKey({ withdrawalId: WID, gen2PermitId: GEN2_PERMIT_ID }),
      {
        id: 'claim-gen2',
        eventType: PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
        status: 'DISPATCHED',
        aggregateType: 'withdrawal',
        aggregateId: WID,
        payload: { withdrawalId: WID, gen2PermitId: GEN2_PERMIT_ID, authorizationGeneration: 2 },
      },
    );
  }
  if (options?.withGen3Claim !== false) {
    world.outbox.set(
      buildPhase21Gen3TemporalLaunchClaimDedupeKey({ withdrawalId: WID, gen3PermitId: GEN3_PERMIT_ID }),
      {
        id: 'claim-gen3',
        eventType: PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
        status: 'DISPATCHED',
        aggregateType: 'withdrawal',
        aggregateId: WID,
        payload: gen3ClaimPayload(),
      },
    );
  }
  return world;
}

export function gen3ClaimKey(): string {
  return buildPhase21Gen3TemporalLaunchClaimDedupeKey({
    withdrawalId: WID,
    gen3PermitId: GEN3_PERMIT_ID,
  });
}

function permitSqlRow(p: MockPermit): Record<string, unknown> {
  const b = PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS;
  return {
    id: p.id,
    withdrawal_id: p.withdrawalId,
    authorization_generation: p.generation,
    public_id: b.publicId,
    authorized_gross_atomic: b.authorizedGrossAtomic.toString(10),
    authorized_fee_atomic: b.authorizedFeeAtomic.toString(10),
    authorized_net_atomic: b.authorizedNetAtomic.toString(10),
    authorized_recipient_friendly: b.authorizedRecipientFriendly,
    authorized_recipient_raw: b.authorizedRecipientRaw,
    authorized_network_code: b.authorizedNetworkCode,
    authorized_asset_symbol: b.authorizedAssetSymbol,
    authorized_jetton_master: b.authorizedJettonMaster,
    authorized_attached_gram_atomic: b.authorizedAttachedGramAtomic.toString(10),
    authorized_forward_gram_atomic: b.authorizedForwardGramAtomic.toString(10),
    status: p.status,
    consumed_attempt_id: p.consumedAttemptId,
    created_by_admin_user_id: ADMIN_ID,
    created_at: new Date('2026-10-15T00:00:00.000Z'),
    consumed_at: p.status === 'CONSUMED' ? new Date('2026-10-15T00:01:00.000Z') : null,
    cancelled_at: null,
    cancel_reason: null,
    idempotency_key: phase21ManualDispatchGenerationIdempotencyKey(p.withdrawalId, p.generation),
    audit_correlation_id: null,
  };
}

export function mockGen4Client(world: Gen4MockWorld) {
  let outboxSeq = 0;
  return {
    query: vi.fn(async (rawSql: string, params?: readonly unknown[]) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      world.log.push(sql);

      if (
        sql === 'BEGIN' ||
        sql === 'BEGIN READ ONLY' ||
        sql === 'COMMIT' ||
        sql === 'ROLLBACK'
      ) {
        return { rows: [] };
      }

      if (sql.includes('FROM feature_flags') && sql.includes('PAYOUT_DISPATCH_PAUSE')) {
        return { rows: [{ enabled: world.paused }] };
      }

      if (sql.includes('FROM withdrawals')) {
        return {
          rows: [
            {
              id: world.withdrawalId,
              public_id: world.publicId,
              state: world.state,
              requested_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10),
              fee_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10),
              net_amount_atomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
              reservation_ledger_tx_id: world.reservation,
              release_ledger_tx_id: world.release,
              settlement_ledger_tx_id: world.settlement,
              network_code: PHASE21_NETWORK_CODE,
              recipient_friendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
              recipient_raw: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
            },
          ],
        };
      }

      if (sql.includes('INSERT INTO phase21_manual_dispatch_permits')) {
        const p: MockPermit = {
          id: String(params?.[0]),
          withdrawalId: String(params?.[1]),
          generation: Number(params?.[2]),
          status: 'ARMED',
          consumedAttemptId: null,
        };
        world.permits.push(p);
        return { rows: [permitSqlRow(p)] };
      }

      if (sql.includes('FROM phase21_manual_dispatch_permits')) {
        if (sql.includes('FOR UPDATE')) {
          return {
            rows: [...world.permits]
              .sort((a, b) => a.generation - b.generation)
              .map((p) => ({
                id: p.id,
                authorization_generation: p.generation,
                status: p.status,
                consumed_attempt_id: p.consumedAttemptId,
              })),
          };
        }
        if (sql.includes('authorization_generation = $2::int')) {
          const gen = Number(params?.[1]);
          const found = world.permits.find((p) => p.generation === gen);
          return { rows: found ? [permitSqlRow(found)] : [] };
        }
        if (sql.includes("status = 'ARMED'")) {
          const armed = world.permits.find((p) => p.status === 'ARMED');
          return {
            rows: armed ? [{ id: armed.id, authorization_generation: armed.generation }] : [],
          };
        }
      }

      if (sql.startsWith('INSERT INTO audit_logs')) {
        return { rows: [{ id: 'audit-1' }] };
      }

      if (sql.startsWith('INSERT INTO outbox_events')) {
        const isClaim = sql.includes("'DISPATCHED'::outbox_event_status");
        const dedupeKey = String(isClaim ? params?.[3] : params?.[4]);
        if (world.outbox.has(dedupeKey)) return { rows: [] };
        outboxSeq += 1;
        world.outbox.set(dedupeKey, {
          id: `outbox-${outboxSeq}`,
          eventType: String(isClaim ? params?.[1] : params?.[2]),
          status: isClaim ? 'DISPATCHED' : 'PENDING',
          aggregateType: 'withdrawal',
          aggregateId: String(params?.[isClaim ? 0 : 1]),
          payload: JSON.parse(String(isClaim ? params?.[2] : params?.[3])) as unknown,
        });
        return { rows: [{ id: `outbox-${outboxSeq}` }] };
      }

      if (sql.includes('FROM outbox_events')) {
        const key = String(params?.[0]);
        const row = world.outbox.get(key);
        if (sql.includes('count(*)')) {
          const n =
            row === undefined
              ? 0
              : sql.includes("status = 'DISPATCHED'")
                ? row.status === 'DISPATCHED'
                  ? 1
                  : 0
                : 1;
          return { rows: [{ n }] };
        }
        if (sql.includes('payload')) {
          return {
            rows:
              row === undefined
                ? []
                : [
                    {
                      id: row.id,
                      aggregate_id: row.aggregateId,
                      aggregate_type: row.aggregateType,
                      event_type: row.eventType,
                      status: row.status,
                      payload: row.payload,
                    },
                  ],
          };
        }
        return { rows: row === undefined ? [] : [{ id: row.id }] };
      }

      if (sql.includes('FROM withdrawal_attempts')) {
        const sorted = [...world.attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
        if (sql.includes('attempt_number IN (1, 2, 3)')) {
          return {
            rows: sorted
              .filter((a) => a.attemptNumber >= 1 && a.attemptNumber <= 3)
              .map((a) => ({ id: a.id, attempt_number: a.attemptNumber })),
          };
        }
        if (sql.includes('FOR UPDATE')) {
          return { rows: sorted.map((a) => ({ query_id: a.queryId })) };
        }
        if (sql.includes('AS attempt3_failed_pre')) {
          const failedPre = (a: MockAttempt) => a.state === 'FAILED_PRE_BROADCAST';
          return {
            rows: [
              {
                c: sorted.length,
                failed_pre: sorted.filter(failedPre).length,
                evidence: sorted.filter((a) => a.hasEvidence).length,
                attempt1_failed_pre: sorted.filter((a) => a.attemptNumber === 1 && failedPre(a)).length,
                attempt2_failed_pre: sorted.filter((a) => a.attemptNumber === 2 && failedPre(a)).length,
                attempt3_failed_pre: sorted.filter((a) => a.attemptNumber === 3 && failedPre(a)).length,
              },
            ],
          };
        }
        if (sql.includes('attempt_number = 3')) {
          return {
            rows: sorted
              .filter((a) => a.attemptNumber === 3)
              .map((a) => ({
                id: a.id,
                broadcast_result_state: a.state,
                query_id: a.queryId,
              })),
          };
        }
        if (sql.includes('ORDER BY attempt_number')) {
          return { rows: sorted.map((a) => ({ query_id: a.queryId })) };
        }
      }

      throw new Error(`unexpected SQL in Gen-4 mock: ${sql.slice(0, 200)}`);
    }),
  };
}
