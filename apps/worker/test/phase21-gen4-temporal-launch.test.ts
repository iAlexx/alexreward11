/**
 * Phase 21 Gen-4 Temporal launch - disposable Temporal integration / regression.
 *
 * Uses TestWorkflowEnvironment only. Never touches production Temporal / Mainnet.
 * Asserts ALLOW_DUPLICATE + FAIL policies, maximumAttempts=1, Gen-3 run identity
 * one-shot guard (expectedGen3RunId), refuse-while-running, refuse sequential re-launch
 * after Gen-4, Gen-3 launch claim BINDING (not mere presence), and the durable Gen-3
 * terminal path when Temporal history is absent.
 */
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS,
  PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  buildPhase21Gen4TemporalLaunchClaimDedupeKey,
  buildPhase21Gen4TemporalLaunchStartOptions,
  evaluatePhase21Gen4DurableGen3TerminalEvidence,
  evaluatePhase21Gen4PriorWorkflowIdentity,
  evaluatePhase21Gen4TemporalLaunchEligibility,
  executePhase21Gen4TemporalLaunch,
  mintPhase21Gen4IndependentChainReconciliationForTests,
  withdrawalWorkflowId,
  type Phase21Gen4TemporalLaunchPlanResult,
} from '@alex-rewards/withdrawals';

import {
  REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS,
  withdrawalPayoutWorkflow,
} from '../src/workflows.js';

const WID = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
const GEN1_PERMIT_ID = 'permit-gen1';
const GEN2_PERMIT_ID = 'permit-gen2';
const GEN3_PERMIT_ID = 'permit-gen3';
const GEN4_PERMIT_ID = 'permit-gen4';

const DURABLE_GEN3_TERMINAL = {
  gen1PermitStatus: 'CONSUMED',
  gen1ConsumedAttemptId: 'attempt-1',
  gen2PermitStatus: 'CONSUMED',
  gen2ConsumedAttemptId: 'attempt-2',
  gen3PermitStatus: 'CONSUMED',
  gen3ConsumedAttemptId: 'attempt-3',
  attemptCount: 3,
  failedPreAttemptCount: 3,
  broadcastEvidenceCount: 0,
  gen2TemporalLaunchClaimPresent: true,
  gen3TemporalLaunchClaimBound: true,
  gen4PermitStatus: 'ARMED',
  gen4TemporalLaunchClaimAbsent: true,
} as const;

const baseEligibility = {
  withdrawalState: 'FAILED_PRE_BROADCAST',
  gen1PermitStatus: 'CONSUMED',
  gen2PermitStatus: 'CONSUMED',
  gen3PermitStatus: 'CONSUMED',
  gen4PermitStatus: 'ARMED',
  gen4AuthorizationGeneration: 4,
  attemptCount: 3,
  failedPreAttemptCount: 3,
  broadcastEvidenceCount: 0,
  gen2TemporalLaunchClaimPresent: true,
  gen3TemporalLaunchClaimBound: true,
  reservationHeld: true,
  settlementPresent: false,
  releasePresent: false,
  chainReconOk: true,
  globalRelayEnabled: false,
  deployShaOk: true,
  signerReady: true,
  signerUnlocked: true,
  expectedGen3RunId: 'gen3-run',
  priorWorkflowFound: true,
  observedPriorRunId: 'gen3-run',
  priorWorkflowStatus: 'COMPLETED',
  workflowStillRunning: false,
};

function permitSqlRow(id: string, generation: number, status: string, attemptId: string | null) {
  return {
    id,
    withdrawal_id: WID,
    authorization_generation: generation,
    public_id: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
    authorized_gross_atomic: '200000',
    authorized_fee_atomic: '10000',
    authorized_net_atomic: '190000',
    authorized_recipient_friendly: 'EQ_recipient',
    authorized_recipient_raw: '0:recipient',
    authorized_network_code: 'TON_MAINNET',
    authorized_asset_symbol: 'USDT',
    authorized_jetton_master: 'EQ_master',
    authorized_attached_gram_atomic: '50000000',
    authorized_forward_gram_atomic: '1',
    status,
    consumed_attempt_id: attemptId,
    created_by_admin_user_id: '55555555-5555-4555-8555-555555555555',
    created_at: new Date(),
    consumed_at: status === 'CONSUMED' ? new Date() : null,
    cancelled_at: null,
    cancel_reason: null,
    idempotency_key: `k:${generation}`,
    audit_correlation_id: null,
  };
}

/** SQL-pattern claim client: Gen-1/2/3 CONSUMED, Gen-4 ARMED, bound Gen-3 launch claim, 3 attempts. */
function createClaimClient(options?: { readonly forgeGen3Claim?: boolean }) {
  const gen3Key = buildPhase21Gen3TemporalLaunchClaimDedupeKey({
    withdrawalId: WID,
    gen3PermitId: GEN3_PERMIT_ID,
  });
  const claims = new Map<string, { id: string; payload: unknown; eventType: string }>();
  const inserts: Array<readonly unknown[]> = [];
  const permits: ReadonlyArray<readonly [string, number, string, string | null]> = [
    [GEN1_PERMIT_ID, 1, 'CONSUMED', 'attempt-1'],
    [GEN2_PERMIT_ID, 2, 'CONSUMED', 'attempt-2'],
    [GEN3_PERMIT_ID, 3, 'CONSUMED', 'attempt-3'],
    [GEN4_PERMIT_ID, 4, 'ARMED', null],
  ];
  return {
    claims,
    inserts,
    query: async (sql: string, params?: readonly unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('FROM feature_flags')) return { rows: [{ enabled: true }] };
      if (s.includes('FROM withdrawals')) {
        return {
          rows: [
            {
              id: WID,
              public_id: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
              state: 'FAILED_PRE_BROADCAST',
              reservation_ledger_tx_id: 'res-1',
              settlement_ledger_tx_id: null,
              release_ledger_tx_id: null,
            },
          ],
        };
      }
      if (s.includes('FROM phase21_manual_dispatch_permits')) {
        if (s.includes('FOR UPDATE')) {
          return {
            rows: permits.map(([id, g, status, a]) => ({
              id,
              authorization_generation: g,
              status,
              consumed_attempt_id: a,
            })),
          };
        }
        const gen = Number(params?.[1]);
        const found = permits.find(([, g]) => g === gen);
        return {
          rows: found ? [permitSqlRow(found[0], found[1], found[2], found[3])] : [],
        };
      }
      if (s.startsWith('INSERT INTO outbox_events')) {
        inserts.push(params ?? []);
        const key = String(params?.[3]);
        if (claims.has(key)) return { rows: [] };
        claims.set(key, {
          id: `claim-${claims.size + 1}`,
          eventType: String(params?.[1]),
          payload: JSON.parse(String(params?.[2])) as unknown,
        });
        return { rows: [{ id: `claim-${claims.size}` }] };
      }
      if (s.includes('FROM outbox_events')) {
        const key = String(params?.[0]);
        if (s.includes('count(*)')) {
          // Gen-2 claim is always present; Gen-3 present; Gen-4 as inserted.
          const present = key.includes('gen2') || key === gen3Key || claims.has(key);
          return { rows: [{ n: present ? 1 : 0 }] };
        }
        if (key === gen3Key) {
          return {
            rows: [
              {
                id: 'claim-gen3',
                aggregate_id: WID,
                aggregate_type: 'withdrawal',
                event_type: PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
                status: 'DISPATCHED',
                payload: {
                  withdrawalId: WID,
                  gen3PermitId: options?.forgeGen3Claim === true ? 'permit-other' : GEN3_PERMIT_ID,
                  workflowId: withdrawalWorkflowId(WID),
                  authorizationGeneration: 3,
                  broadcastPerformed: false,
                  signed: false,
                },
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (s.includes('FROM withdrawal_attempts')) {
        if (s.includes('attempt_number IN (1, 2, 3)')) {
          return {
            rows: [
              { id: 'attempt-1', attempt_number: 1 },
              { id: 'attempt-2', attempt_number: 2 },
              { id: 'attempt-3', attempt_number: 3 },
            ],
          };
        }
        if (s.includes('AS attempt3_failed_pre')) {
          return {
            rows: [
              {
                c: 3,
                failed_pre: 3,
                evidence: 0,
                attempt1_failed_pre: 1,
                attempt2_failed_pre: 1,
                attempt3_failed_pre: 1,
              },
            ],
          };
        }
        if (s.includes('attempt_number = 3')) {
          return {
            rows: [
              {
                id: 'attempt-3',
                broadcast_result_state: 'FAILED_PRE_BROADCAST',
                query_id: '900000000003',
              },
            ],
          };
        }
        return {
          rows: [{ query_id: '900000000001' }, { query_id: '900000000002' }, { query_id: '900000000003' }],
        };
      }
      return { rows: [] };
    },
  };
}

describe('phase21 Gen-4 Temporal launch integration', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('preserves real-chain maximumAttempts=1 (no automatic re-sign on attempt #4)', () => {
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.retry.maximumAttempts).toBe(1);
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.startToCloseTimeout).toBe('5 minutes');
    expect(JSON.stringify(buildPhase21Gen4TemporalLaunchStartOptions({
      withdrawalId: WID,
      taskQueue: 'tq',
    }))).not.toContain('maximumAttempts');
  });

  it('eligibility refuses relay ON, the Gen-3 (two-attempt) shape and an unbound Gen-3 claim', () => {
    expect(evaluatePhase21Gen4TemporalLaunchEligibility(baseEligibility).eligible).toBe(true);
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({ ...baseEligibility, globalRelayEnabled: true }).reason,
    ).toBe('global_relay_must_remain_off');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        attemptCount: 2,
        failedPreAttemptCount: 2,
      }).reason,
    ).toBe('prior_attempt_count_not_three');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        gen3TemporalLaunchClaimBound: false,
      }).reason,
    ).toBe('gen3_launch_claim_not_bound');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        gen2TemporalLaunchClaimPresent: false,
      }).reason,
    ).toBe('gen2_launch_claim_missing');
  });

  it('ALLOW_DUPLICATE after Gen-3 closed + ConflictPolicy FAIL while RUNNING + refuse sequential Gen-4 re-launch', async () => {
    const withdrawalId = WID;
    const taskQueue = `phase21-gen4-launch-${Date.now()}`;
    const opts = buildPhase21Gen4TemporalLaunchStartOptions({ withdrawalId, taskQueue });

    const activities = {
      async executeWithdrawalFakePayout() {
        return { state: 'CONFIRMED', attemptId: null };
      },
      async executeWithdrawalTestnetPayout() {
        // Hang briefly so a concurrent start can observe RUNNING.
        await new Promise((r) => setTimeout(r, 1500));
        return { state: 'CONFIRMED', attemptId: 'attempt-4-sim' };
      },
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities,
    });

    await worker.runUntil(async () => {
      const startClosed = async () => {
        const h = await testEnv.client.workflow.start(withdrawalPayoutWorkflow, {
          taskQueue,
          workflowId: opts.workflowId,
          args: [{ withdrawalId, realChainEnabled: true }],
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
        });
        await h.result();
        return h.firstExecutionRunId;
      };
      const gen1RunId = await startClosed();
      const gen2RunId = await startClosed();
      // Gen-3 closed execution - this run is the verified Gen-4 prior identity.
      const gen3RunId = await startClosed();
      expect(new Set([gen1RunId, gen2RunId, gen3RunId]).size).toBe(3);

      const gen3Describe = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(gen3Describe.runId).toBe(gen3RunId);
      expect(
        evaluatePhase21Gen4PriorWorkflowIdentity({
          expectedGen3RunId: gen3RunId,
          observation: {
            found: true,
            runId: gen3Describe.runId,
            status: gen3Describe.status.name,
          },
        }),
      ).toMatchObject({ ok: true, identityMode: 'live_gen3_run' });

      // Binding to a stale Gen-1 / Gen-2 run must refuse.
      for (const stale of [gen1RunId, gen2RunId]) {
        expect(
          evaluatePhase21Gen4PriorWorkflowIdentity({
            expectedGen3RunId: stale,
            observation: {
              found: true,
              runId: gen3Describe.runId,
              status: gen3Describe.status.name,
            },
          }).reason,
        ).toBe('gen4_already_launched_or_run_mismatch');
      }

      const plan: Phase21Gen4TemporalLaunchPlanResult = {
        ok: true,
        mode: 'PLAN',
        withdrawalId,
        publicId: 'WD-000001',
        workflowId: opts.workflowId,
        readyForExecute: true,
        checks: [],
        gen1PermitStatus: 'CONSUMED',
        gen1ConsumedAttemptId: 'attempt-1',
        gen2PermitId: GEN2_PERMIT_ID,
        gen2PermitStatus: 'CONSUMED',
        gen2ConsumedAttemptId: 'attempt-2',
        gen2TemporalLaunchClaimPresent: true,
        gen3PermitId: GEN3_PERMIT_ID,
        gen3PermitStatus: 'CONSUMED',
        gen3ConsumedAttemptId: 'attempt-3',
        gen3TemporalLaunchClaimBound: true,
        gen4PermitId: GEN4_PERMIT_ID,
        gen4PermitStatus: 'ARMED',
        attemptCount: 3,
        reservationHeld: true,
        globalRelayEnabled: false,
        priorWorkflowIdentityMode: 'live_gen3_run',
        startOptions: opts,
        broadcastPerformed: false,
        signed: false,
        mutated: false,
        relayEnabled: false,
      };

      const claimClient = createClaimClient();
      const launched = await executePhase21Gen4TemporalLaunch({
        confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: testEnv.client,
        claimClient: claimClient as never,
        expectedGen3RunId: gen3RunId,
        signerReady: true,
        signerUnlocked: true,
        chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'PRODUCTION',
      });
      expect(launched.ok).toBe(true);
      expect(launched.started).toBe(true);
      expect(launched.relayEnabled).toBe(false);
      expect(launched.signed).toBe(false);
      expect(launched.broadcastPerformed).toBe(false);
      const gen4RunId = launched.runId;
      expect(gen4RunId).toBeTruthy();
      expect(new Set([gen1RunId, gen2RunId, gen3RunId, gen4RunId]).size).toBe(4);
      expect(claimClient.inserts).toHaveLength(1);
      expect(claimClient.inserts[0]?.[1]).toBe(PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE);
      expect(claimClient.inserts[0]?.[3]).toBe(
        buildPhase21Gen4TemporalLaunchClaimDedupeKey({
          withdrawalId,
          gen4PermitId: GEN4_PERMIT_ID,
        }),
      );
      expect(
        claimClient.claims.get(
          buildPhase21Gen4TemporalLaunchClaimDedupeKey({ withdrawalId, gen4PermitId: GEN4_PERMIT_ID }),
        )?.payload,
      ).toMatchObject({ expectedGen3RunId: gen3RunId, authorizationGeneration: 4 });

      // While RUNNING, ConflictPolicy FAIL must refuse a second start.
      await expect(
        testEnv.client.workflow.start(withdrawalPayoutWorkflow, {
          taskQueue,
          workflowId: opts.workflowId,
          args: [{ withdrawalId, realChainEnabled: true }],
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
        }),
      ).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);

      // A repeated Owner EXECUTE while running is refused by the durable claim.
      const repeated = await executePhase21Gen4TemporalLaunch({
        confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: testEnv.client,
        claimClient: claimClient as never,
        expectedGen3RunId: gen3RunId,
        signerReady: true,
        signerUnlocked: true,
        chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'PRODUCTION',
      });
      expect(repeated).toMatchObject({
        started: false,
        refuseCode: 'GEN4_TEMPORAL_ALREADY_CLAIMED',
      });

      await testEnv.client.workflow.getHandle(opts.workflowId).result();

      // After Gen-4 COMPLETED, live runId != Gen-3 -> sequential re-launch refused.
      const afterGen4 = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(afterGen4.status.name).toBe('COMPLETED');
      expect(afterGen4.runId).toBe(gen4RunId);
      expect(
        evaluatePhase21Gen4PriorWorkflowIdentity({
          expectedGen3RunId: gen3RunId,
          observation: {
            found: true,
            runId: afterGen4.runId,
            status: afterGen4.status.name,
          },
        }).reason,
      ).toBe('gen4_already_launched_or_run_mismatch');
      expect(
        evaluatePhase21Gen4TemporalLaunchEligibility({
          ...baseEligibility,
          expectedGen3RunId: gen3RunId,
          observedPriorRunId: afterGen4.runId,
          priorWorkflowStatus: afterGen4.status.name,
        }).reason,
      ).toBe('gen4_already_launched_or_run_mismatch');
    });
  }, 180_000);

  it('refuses to start Temporal when the Gen-3 launch claim is present but forged (binding, not presence)', async () => {
    const withdrawalId = WID;
    const taskQueue = `phase21-gen4-forged-${Date.now()}`;
    const opts = buildPhase21Gen4TemporalLaunchStartOptions({ withdrawalId, taskQueue });
    const started: unknown[] = [];
    const plan = {
      ok: true,
      mode: 'PLAN',
      withdrawalId,
      publicId: 'WD-000001',
      workflowId: opts.workflowId,
      readyForExecute: true,
      checks: [],
      gen1PermitStatus: 'CONSUMED',
      gen1ConsumedAttemptId: 'attempt-1',
      gen2PermitId: GEN2_PERMIT_ID,
      gen2PermitStatus: 'CONSUMED',
      gen2ConsumedAttemptId: 'attempt-2',
      gen2TemporalLaunchClaimPresent: true,
      gen3PermitId: GEN3_PERMIT_ID,
      gen3PermitStatus: 'CONSUMED',
      gen3ConsumedAttemptId: 'attempt-3',
      gen3TemporalLaunchClaimBound: true,
      gen4PermitId: GEN4_PERMIT_ID,
      gen4PermitStatus: 'ARMED',
      attemptCount: 3,
      reservationHeld: true,
      globalRelayEnabled: false,
      priorWorkflowIdentityMode: 'durable_gen3_terminal',
      startOptions: opts,
      broadcastPerformed: false,
      signed: false,
      mutated: false,
      relayEnabled: false,
    } satisfies Phase21Gen4TemporalLaunchPlanResult;

    const result = await executePhase21Gen4TemporalLaunch({
      confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: {
        workflow: {
          start: async (...args: unknown[]) => {
            started.push(args);
            return { firstExecutionRunId: 'never' };
          },
        },
      },
      claimClient: createClaimClient({ forgeGen3Claim: true }) as never,
      expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
      signerReady: true,
      signerUnlocked: true,
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests(),
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(result).toMatchObject({
      started: false,
      refuseCode: 'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_PAYLOAD_WRONG_PERMIT',
    });
    expect(started).toHaveLength(0);
  });

  it('refuses EXECUTE with a LOCKED / not-ready signer before any claim or Temporal start', async () => {
    const opts = buildPhase21Gen4TemporalLaunchStartOptions({ withdrawalId: WID, taskQueue: 'tq' });
    const started: unknown[] = [];
    const plan = {
      ok: true,
      mode: 'PLAN',
      withdrawalId: WID,
      publicId: 'WD-000001',
      workflowId: opts.workflowId,
      readyForExecute: true,
      checks: [],
      gen1PermitStatus: 'CONSUMED',
      gen1ConsumedAttemptId: 'attempt-1',
      gen2PermitId: GEN2_PERMIT_ID,
      gen2PermitStatus: 'CONSUMED',
      gen2ConsumedAttemptId: 'attempt-2',
      gen2TemporalLaunchClaimPresent: true,
      gen3PermitId: GEN3_PERMIT_ID,
      gen3PermitStatus: 'CONSUMED',
      gen3ConsumedAttemptId: 'attempt-3',
      gen3TemporalLaunchClaimBound: true,
      gen4PermitId: GEN4_PERMIT_ID,
      gen4PermitStatus: 'ARMED',
      attemptCount: 3,
      reservationHeld: true,
      globalRelayEnabled: false,
      priorWorkflowIdentityMode: 'durable_gen3_terminal',
      startOptions: opts,
      broadcastPerformed: false,
      signed: false,
      mutated: false,
      relayEnabled: false,
    } satisfies Phase21Gen4TemporalLaunchPlanResult;
    for (const signer of [
      { signerReady: true, signerUnlocked: false },
      { signerReady: false, signerUnlocked: true },
    ]) {
      const claimClient = createClaimClient();
      const result = await executePhase21Gen4TemporalLaunch({
        confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: {
          workflow: {
            start: async (...args: unknown[]) => {
              started.push(args);
              return { firstExecutionRunId: 'never' };
            },
          },
        },
        claimClient: claimClient as never,
        expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
        ...signer,
        chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'PRODUCTION',
      });
      expect(result).toMatchObject({ started: false, refuseCode: 'SIGNER_NOT_READY_FOR_EXECUTE' });
      expect(claimClient.inserts).toHaveLength(0);
    }
    expect(started).toHaveLength(0);
  });

  it('missing prior workflow fails closed without durable evidence (never assumes COMPLETED)', () => {
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
        observation: { found: false },
      }).reason,
    ).toBe('prior_workflow_not_found');
  });

  it('durable Gen-3 terminal evidence opens the gate when Temporal history is absent', () => {
    expect(evaluatePhase21Gen4DurableGen3TerminalEvidence(DURABLE_GEN3_TERMINAL).ok).toBe(true);
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
        observation: { found: false },
        durableGen3Terminal: DURABLE_GEN3_TERMINAL,
      }),
    ).toMatchObject({
      ok: true,
      identityMode: 'durable_gen3_terminal',
      priorWorkflowStatus: PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS,
    });
    expect(PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS).toBe(
      'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN3_TERMINAL',
    );
    // Missing durable Gen-3 binding / Gen-2 claim keeps the gate closed.
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
        observation: { found: false },
        durableGen3Terminal: { ...DURABLE_GEN3_TERMINAL, gen3TemporalLaunchClaimBound: false },
      }).reason,
    ).toBe('durable_gen3_launch_claim_not_bound');
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '01a3cccc-dddd-eeee-ffff-000000000000',
        observation: { found: false },
        durableGen3Terminal: { ...DURABLE_GEN3_TERMINAL, gen2TemporalLaunchClaimPresent: false },
      }).reason,
    ).toBe('durable_gen2_launch_claim_missing');
    // Expected Gen-3 run id is still mandatory on the durable path.
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '',
        observation: { found: false },
        durableGen3Terminal: DURABLE_GEN3_TERMINAL,
      }).reason,
    ).toBe('expected_gen3_run_id_missing');
  });
});
