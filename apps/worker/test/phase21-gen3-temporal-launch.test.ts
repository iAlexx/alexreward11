/**
 * Phase 21 Gen-3 Temporal launch - disposable Temporal integration / regression.
 *
 * Uses TestWorkflowEnvironment only. Never touches production Temporal / Mainnet.
 * Asserts ALLOW_DUPLICATE + FAIL policies, maximumAttempts=1, Gen-2 run identity
 * one-shot guard, refuse-while-running, and refuse sequential re-launch after Gen-3.
 */
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  buildPhase21Gen3TemporalLaunchStartOptions,
  evaluatePhase21Gen3DurableGen2TerminalEvidence,
  evaluatePhase21Gen3PriorWorkflowIdentity,
  evaluatePhase21Gen3TemporalLaunchEligibility,
  executePhase21Gen3TemporalLaunch,
  mintPhase21Gen3IndependentChainReconciliationForTests,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  type Phase21Gen3TemporalLaunchPlanResult,
} from '@alex-rewards/withdrawals';

import {
  REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS,
  withdrawalPayoutWorkflow,
} from '../src/workflows.js';

const GEN1_PERMIT_ID = 'permit-gen1';
const GEN2_PERMIT_ID = 'permit-gen2';
const GEN3_PERMIT_ID = 'permit-gen3';

const DURABLE_GEN2_TERMINAL = {
  gen1PermitStatus: 'CONSUMED',
  gen1ConsumedAttemptId: 'attempt-1',
  gen2PermitStatus: 'CONSUMED',
  gen2ConsumedAttemptId: 'attempt-2',
  attemptCount: 2,
  failedPreAttemptCount: 2,
  broadcastEvidenceCount: 0,
  gen2TemporalLaunchClaimPresent: true,
  gen3PermitStatus: 'ARMED',
  gen3TemporalLaunchClaimAbsent: true,
} as const;

describe('phase21 Gen-3 Temporal launch integration', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('preserves real-chain maximumAttempts=1 (no automatic re-sign on attempt #3)', () => {
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.retry.maximumAttempts).toBe(1);
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.startToCloseTimeout).toBe('5 minutes');
  });

  it('eligibility refuses relay ON and the Gen-2 (single attempt) resume shape', () => {
    const base = {
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: 'CONSUMED',
      gen3PermitStatus: 'ARMED',
      gen3AuthorizationGeneration: 3,
      attemptCount: 2,
      failedPreAttemptCount: 2,
      broadcastEvidenceCount: 0,
      gen2TemporalLaunchClaimPresent: true,
      reservationHeld: true,
      settlementPresent: false,
      releasePresent: false,
      chainReconOk: true,
      globalRelayEnabled: false,
      deployShaOk: true,
      signerReady: true,
      signerUnlocked: true,
      expectedGen2RunId: 'gen2-run',
      priorWorkflowFound: true,
      observedPriorRunId: 'gen2-run',
      priorWorkflowStatus: 'COMPLETED',
      workflowStillRunning: false,
    };
    expect(evaluatePhase21Gen3TemporalLaunchEligibility(base).eligible).toBe(true);
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...base, globalRelayEnabled: true }).reason,
    ).toBe('global_relay_must_remain_off');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...base,
        attemptCount: 1,
        failedPreAttemptCount: 1,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...base,
        gen2TemporalLaunchClaimPresent: false,
      }).reason,
    ).toBe('gen2_launch_claim_missing');
  });

  it('ALLOW_DUPLICATE after Gen-2 closed + ConflictPolicy FAIL while RUNNING + refuse sequential Gen-3 re-launch', async () => {
    const withdrawalId = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
    const taskQueue = `phase21-gen3-launch-${Date.now()}`;
    const opts = buildPhase21Gen3TemporalLaunchStartOptions({ withdrawalId, taskQueue });

    const activities = {
      async executeWithdrawalFakePayout() {
        return { state: 'CONFIRMED', attemptId: null };
      },
      async executeWithdrawalTestnetPayout() {
        // Hang briefly so a concurrent start can observe RUNNING.
        await new Promise((r) => setTimeout(r, 1500));
        return { state: 'CONFIRMED', attemptId: 'attempt-3-sim' };
      },
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities,
    });

    await worker.runUntil(async () => {
      // Gen-1 closed execution.
      const first = await testEnv.client.workflow.start(withdrawalPayoutWorkflow, {
        taskQueue,
        workflowId: opts.workflowId,
        args: [{ withdrawalId, realChainEnabled: true }],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      });
      const gen1RunId = first.firstExecutionRunId;
      await first.result();

      // Gen-2 closed execution - this run is the verified Gen-3 prior identity.
      const second = await testEnv.client.workflow.start(withdrawalPayoutWorkflow, {
        taskQueue,
        workflowId: opts.workflowId,
        args: [{ withdrawalId, realChainEnabled: true }],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      });
      const gen2RunId = second.firstExecutionRunId;
      await second.result();
      expect(gen2RunId).not.toBe(gen1RunId);

      const gen2Describe = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(gen2Describe.runId).toBe(gen2RunId);
      expect(
        evaluatePhase21Gen3PriorWorkflowIdentity({
          expectedGen2RunId: gen2RunId,
          observation: {
            found: true,
            runId: gen2Describe.runId,
            status: gen2Describe.status.name,
          },
        }),
      ).toMatchObject({ ok: true, identityMode: 'live_gen2_run' });

      // Binding to the stale Gen-1 run must refuse.
      expect(
        evaluatePhase21Gen3PriorWorkflowIdentity({
          expectedGen2RunId: gen1RunId,
          observation: {
            found: true,
            runId: gen2Describe.runId,
            status: gen2Describe.status.name,
          },
        }).reason,
      ).toBe('gen3_already_launched_or_run_mismatch');

      const plan: Phase21Gen3TemporalLaunchPlanResult = {
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
        gen3PermitStatus: 'ARMED',
        attemptCount: 2,
        reservationHeld: true,
        globalRelayEnabled: false,
        priorWorkflowIdentityMode: 'live_gen2_run',
        startOptions: opts,
        broadcastPerformed: false,
        signed: false,
        mutated: false,
        relayEnabled: false,
      };

      const claimInserts: Array<readonly unknown[]> = [];
      let claimed = false;
      const claimClient = {
        query: async (sql: string, params?: readonly unknown[]) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (typeof sql === 'string' && sql.includes('FROM feature_flags')) {
            return { rows: [{ enabled: true }] };
          }
          if (
            typeof sql === 'string' &&
            sql.includes('FROM withdrawals') &&
            sql.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  id: withdrawalId,
                  public_id: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
                  state: 'FAILED_PRE_BROADCAST',
                  reservation_ledger_tx_id: 'res-1',
                  settlement_ledger_tx_id: null,
                  release_ledger_tx_id: null,
                },
              ],
            };
          }
          if (
            typeof sql === 'string' &&
            sql.includes('FROM phase21_manual_dispatch_permits') &&
            sql.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  id: GEN1_PERMIT_ID,
                  authorization_generation: 1,
                  status: 'CONSUMED',
                  consumed_attempt_id: 'attempt-1',
                },
                {
                  id: GEN2_PERMIT_ID,
                  authorization_generation: 2,
                  status: 'CONSUMED',
                  consumed_attempt_id: 'attempt-2',
                },
                {
                  id: GEN3_PERMIT_ID,
                  authorization_generation: 3,
                  status: 'ARMED',
                  consumed_attempt_id: null,
                },
              ],
            };
          }
          if (
            typeof sql === 'string' &&
            sql.includes('FROM outbox_events') &&
            sql.includes('DISPATCHED')
          ) {
            return { rows: [{ n: 1 }] };
          }
          if (
            typeof sql === 'string' &&
            sql.includes('FROM withdrawal_attempts') &&
            sql.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  attempt_number: 1,
                  broadcast_result_state: 'FAILED_PRE_BROADCAST',
                  has_evidence: false,
                },
                {
                  attempt_number: 2,
                  broadcast_result_state: 'FAILED_PRE_BROADCAST',
                  has_evidence: false,
                },
              ],
            };
          }
          if (typeof sql === 'string' && sql.includes('INSERT INTO outbox_events')) {
            claimInserts.push(params ?? []);
            if (claimed) return { rows: [] };
            claimed = true;
            return { rows: [{ id: 'claim-gen3-1' }] };
          }
          return { rows: [] };
        },
      };

      const launched = await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: testEnv.client,
        claimClient: claimClient as never,
        expectedGen2RunId: gen2RunId,
        chainReconciliation: mintPhase21Gen3IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'PRODUCTION',
      });
      expect(launched.ok).toBe(true);
      expect(launched.started).toBe(true);
      expect(launched.relayEnabled).toBe(false);
      expect(launched.signed).toBe(false);
      expect(launched.broadcastPerformed).toBe(false);
      const gen3RunId = launched.runId;
      expect(gen3RunId).toBeTruthy();
      expect(gen3RunId).not.toBe(gen1RunId);
      expect(gen3RunId).not.toBe(gen2RunId);
      expect(claimInserts).toHaveLength(1);
      expect(claimInserts[0]?.[1]).toBe(PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE);
      expect(claimInserts[0]?.[3]).toBe(
        buildPhase21Gen3TemporalLaunchClaimDedupeKey({
          withdrawalId,
          gen3PermitId: GEN3_PERMIT_ID,
        }),
      );

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

      // A repeated Owner EXECUTE while running is refused by the durable claim
      // (and never reaches Temporal twice).
      const repeated = await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: testEnv.client,
        claimClient: claimClient as never,
        expectedGen2RunId: gen2RunId,
        chainReconciliation: mintPhase21Gen3IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'PRODUCTION',
      });
      expect(repeated).toMatchObject({
        started: false,
        refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED',
      });

      await testEnv.client.workflow.getHandle(opts.workflowId).result();

      // After Gen-3 COMPLETED, live runId != Gen-2 -> sequential re-launch refused.
      const afterGen3 = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(afterGen3.status.name).toBe('COMPLETED');
      expect(afterGen3.runId).toBe(gen3RunId);
      expect(
        evaluatePhase21Gen3PriorWorkflowIdentity({
          expectedGen2RunId: gen2RunId,
          observation: {
            found: true,
            runId: afterGen3.runId,
            status: afterGen3.status.name,
          },
        }).reason,
      ).toBe('gen3_already_launched_or_run_mismatch');
      expect(
        evaluatePhase21Gen3TemporalLaunchEligibility({
          withdrawalState: 'FAILED_PRE_BROADCAST',
          gen1PermitStatus: 'CONSUMED',
          gen2PermitStatus: 'CONSUMED',
          gen3PermitStatus: 'ARMED',
          gen3AuthorizationGeneration: 3,
          attemptCount: 2,
          failedPreAttemptCount: 2,
          broadcastEvidenceCount: 0,
          gen2TemporalLaunchClaimPresent: true,
          reservationHeld: true,
          settlementPresent: false,
          releasePresent: false,
          chainReconOk: true,
          globalRelayEnabled: false,
          deployShaOk: true,
          signerReady: true,
          signerUnlocked: true,
          expectedGen2RunId: gen2RunId,
          priorWorkflowFound: true,
          observedPriorRunId: afterGen3.runId,
          priorWorkflowStatus: afterGen3.status.name,
          workflowStillRunning: false,
        }).reason,
      ).toBe('gen3_already_launched_or_run_mismatch');
    });
  }, 180_000);

  it('missing prior workflow fails closed without durable evidence (never assumes COMPLETED)', () => {
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
        observation: { found: false },
      }).reason,
    ).toBe('prior_workflow_not_found');
  });

  it('durable Gen-2 terminal evidence opens the gate when Temporal history is absent', () => {
    expect(evaluatePhase21Gen3DurableGen2TerminalEvidence(DURABLE_GEN2_TERMINAL).ok).toBe(true);
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
        observation: { found: false },
        durableGen2Terminal: DURABLE_GEN2_TERMINAL,
      }),
    ).toMatchObject({
      ok: true,
      identityMode: 'durable_gen2_terminal',
      priorWorkflowStatus: 'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN2_TERMINAL',
    });
    // Missing durable Gen-2 launch claim keeps the gate closed.
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
        observation: { found: false },
        durableGen2Terminal: { ...DURABLE_GEN2_TERMINAL, gen2TemporalLaunchClaimPresent: false },
      }).reason,
    ).toBe('durable_gen2_launch_claim_missing');
  });
});
