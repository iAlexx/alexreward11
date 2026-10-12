/**
 * Phase 21 Gen-2 Temporal launch — disposable Temporal integration / regression.
 *
 * Uses TestWorkflowEnvironment only. Never touches production Temporal / Mainnet.
 * Asserts ALLOW_DUPLICATE + FAIL policies, maximumAttempts=1, Gen-1 run identity
 * one-shot guard, refuse-while-running, and refuse sequential re-launch after Gen-2.
 */
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildPhase21Gen2TemporalLaunchStartOptions,
  evaluatePhase21Gen2PriorWorkflowIdentity,
  evaluatePhase21Gen2TemporalLaunchEligibility,
  executePhase21Gen2TemporalLaunch,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
  type Phase21Gen2TemporalLaunchPlanResult,
} from '@alex-rewards/withdrawals';

import {
  REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS,
  withdrawalPayoutWorkflow,
} from '../src/workflows.js';

describe('phase21 Gen-2 Temporal launch integration', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('preserves real-chain maximumAttempts=1 (no automatic re-sign)', () => {
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.retry.maximumAttempts).toBe(1);
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.startToCloseTimeout).toBe('5 minutes');
  });

  it('eligibility refuses Gen-1-only resume shape and relay ON', () => {
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        gen1PermitStatus: 'CONSUMED',
        gen2PermitStatus: 'ARMED',
        gen2AuthorizationGeneration: 2,
        attemptCount: 1,
        failedPreAttemptCount: 1,
        broadcastEvidenceCount: 0,
        reservationHeld: true,
        settlementPresent: false,
        releasePresent: false,
        chainReconOk: true,
        globalRelayEnabled: true,
        deployShaOk: true,
        signerReady: true,
        signerUnlocked: true,
        expectedGen1RunId: 'gen1-run',
        priorWorkflowFound: true,
        observedPriorRunId: 'gen1-run',
        priorWorkflowStatus: 'COMPLETED',
        workflowStillRunning: false,
      }).reason,
    ).toBe('global_relay_must_remain_off');
  });

  it('ALLOW_DUPLICATE after Gen-1 closed + ConflictPolicy FAIL while RUNNING + refuse sequential Gen-2 re-launch', async () => {
    const withdrawalId = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
    const taskQueue = `phase21-gen2-launch-${Date.now()}`;
    const opts = buildPhase21Gen2TemporalLaunchStartOptions({ withdrawalId, taskQueue });

    const activities = {
      async executeWithdrawalFakePayout() {
        return { state: 'CONFIRMED', attemptId: null };
      },
      async executeWithdrawalTestnetPayout() {
        // Hang briefly so concurrent start can observe RUNNING.
        await new Promise((r) => setTimeout(r, 1500));
        return { state: 'CONFIRMED', attemptId: 'attempt-2-sim' };
      },
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities,
    });

    await worker.runUntil(async () => {
      // Gen-1 closed execution — capture verified run identity for one-shot gate.
      const first = await testEnv.client.workflow.start(withdrawalPayoutWorkflow, {
        taskQueue,
        workflowId: opts.workflowId,
        args: [{ withdrawalId, realChainEnabled: true }],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      });
      const gen1RunId = first.firstExecutionRunId;
      await first.result();

      const gen1Describe = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(
        evaluatePhase21Gen2PriorWorkflowIdentity({
          expectedGen1RunId: gen1RunId,
          observation: {
            found: true,
            runId: gen1Describe.runId,
            status: gen1Describe.status.name,
          },
        }).ok,
      ).toBe(true);

      // Gen-2 Owner launch: ALLOW_DUPLICATE after COMPLETED Gen-1.
      const plan: Phase21Gen2TemporalLaunchPlanResult = {
        ok: true,
        mode: 'PLAN',
        withdrawalId,
        publicId: 'WD-000001',
        workflowId: opts.workflowId,
        readyForExecute: true,
        checks: [],
        gen1PermitStatus: 'CONSUMED',
        gen1ConsumedAttemptId: 'attempt-1',
        gen2PermitId: 'permit-gen2',
        gen2PermitStatus: 'ARMED',
        attemptCount: 1,
        reservationHeld: true,
        globalRelayEnabled: false,
        startOptions: opts,
        broadcastPerformed: false,
        signed: false,
        mutated: false,
        relayEnabled: false,
      };

      const launched = await executePhase21Gen2TemporalLaunch({
        confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: testEnv.client,
      });
      expect(launched.ok).toBe(true);
      expect(launched.started).toBe(true);
      expect(launched.relayEnabled).toBe(false);
      const gen2RunId = launched.runId;
      expect(gen2RunId).toBeTruthy();
      expect(gen2RunId).not.toBe(gen1RunId);

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

      await testEnv.client.workflow.getHandle(opts.workflowId).result();

      // After Gen-2 COMPLETED, live runId ≠ Gen-1 → sequential re-launch refused.
      const afterGen2 = await testEnv.client.workflow.getHandle(opts.workflowId).describe();
      expect(afterGen2.status.name).toBe('COMPLETED');
      expect(afterGen2.runId).toBe(gen2RunId);
      expect(
        evaluatePhase21Gen2PriorWorkflowIdentity({
          expectedGen1RunId: gen1RunId,
          observation: {
            found: true,
            runId: afterGen2.runId,
            status: afterGen2.status.name,
          },
        }).reason,
      ).toBe('gen2_already_launched_or_run_mismatch');
      expect(
        evaluatePhase21Gen2TemporalLaunchEligibility({
          withdrawalState: 'FAILED_PRE_BROADCAST',
          gen1PermitStatus: 'CONSUMED',
          gen2PermitStatus: 'ARMED',
          gen2AuthorizationGeneration: 2,
          attemptCount: 1,
          failedPreAttemptCount: 1,
          broadcastEvidenceCount: 0,
          reservationHeld: true,
          settlementPresent: false,
          releasePresent: false,
          chainReconOk: true,
          globalRelayEnabled: false,
          deployShaOk: true,
          signerReady: true,
          signerUnlocked: true,
          expectedGen1RunId: gen1RunId,
          priorWorkflowFound: true,
          observedPriorRunId: afterGen2.runId,
          priorWorkflowStatus: afterGen2.status.name,
          workflowStillRunning: false,
        }).reason,
      ).toBe('gen2_already_launched_or_run_mismatch');
    });
  }, 180_000);

  it('missing prior workflow fails closed (never assumes COMPLETED)', () => {
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: '01a13154-dc13-739c-92d1-8579627cc06e',
        observation: { found: false },
      }).reason,
    ).toBe('prior_workflow_not_found');
  });
});
