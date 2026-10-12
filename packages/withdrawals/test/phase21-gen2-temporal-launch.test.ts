/**
 * Phase 21 Gen-2 Temporal launch — pure gate + EXECUTE unit tests (no production).
 */
import { describe, expect, it, vi } from 'vitest';

import { PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID } from '../src/phase21-canary-payout-plan.js';
import {
  assertPhase21Gen2TemporalLaunchAck,
  buildPhase21Gen2TemporalLaunchStartOptions,
  evaluatePhase21Gen2LiveDeployShaMatch,
  evaluatePhase21Gen2TemporalLaunchEligibility,
  executePhase21Gen2TemporalLaunch,
  PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY,
  type Phase21Gen2TemporalLaunchPlanResult,
} from '../src/phase21-gen2-temporal-launch.js';
import { evaluatePhase21CanaryFailedPreZeroAttemptRecovery } from '../src/phase21-resume-canary-gates.js';

describe('phase21 Gen-2 Temporal launch gates', () => {
  const base = {
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
    priorWorkflowStatus: 'COMPLETED',
    workflowStillRunning: false,
  };

  it('eligible when Gen-2 ARMED + Gen-1 CONSUMED + FAILED_PRE #1 + gates pass', () => {
    expect(evaluatePhase21Gen2TemporalLaunchEligibility(base)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it('refuses global relay ON', () => {
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({ ...base, globalRelayEnabled: true }).reason,
    ).toBe('global_relay_must_remain_off');
  });

  it('refuses deploy SHA mismatch / signer / running workflow / evidence', () => {
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({ ...base, deployShaOk: false }).reason,
    ).toBe('deploy_sha_mismatch');
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({ ...base, signerReady: false }).reason,
    ).toBe('signer_not_ready');
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({ ...base, workflowStillRunning: true })
        .reason,
    ).toBe('workflow_still_running');
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({ ...base, broadcastEvidenceCount: 1 }).reason,
    ).toBe('broadcast_evidence_exists');
  });

  it('refuses Gen-1 ARMED zero-attempt path confusion (Gen-1 resume remains separate)', () => {
    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'ARMED',
        attemptCount: 1,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }).eligible,
    ).toBe(false);
    expect(
      evaluatePhase21Gen2TemporalLaunchEligibility({
        ...base,
        gen1PermitStatus: 'ARMED',
        gen2PermitStatus: 'ARMED',
      }).eligible,
    ).toBe(false);
  });

  it('deploy SHA match accepts full or prefix equality', () => {
    expect(
      evaluatePhase21Gen2LiveDeployShaMatch({
        expectedDeploySha: 'd8f5bfdf56e369ed453e47c56bfffee1fdd15d7d',
        liveDeploySha: 'd8f5bfdf56e369ed453e47c56bfffee1fdd15d7d',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen2LiveDeployShaMatch({
        expectedDeploySha: 'd8f5bfd',
        liveDeploySha: 'd8f5bfdf56e369ed453e47c56bfffee1fdd15d7d',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen2LiveDeployShaMatch({
        expectedDeploySha: 'aaaaaaaa',
        liveDeploySha: 'd8f5bfd',
      }).reason,
    ).toBe('deploy_sha_mismatch');
  });

  it('start options freeze ALLOW_DUPLICATE + FAIL + realChainEnabled', () => {
    const opts = buildPhase21Gen2TemporalLaunchStartOptions({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      taskQueue: 'alex-rewards-worker',
    });
    expect(opts.workflowIdReusePolicy).toBe(PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY);
    expect(opts.workflowIdConflictPolicy).toBe(PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY);
    expect(opts.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE');
    expect(opts.workflowIdConflictPolicy).toBe('FAIL');
    expect(opts.args[0].realChainEnabled).toBe(true);
    expect(opts.workflowId).toBe(`withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`);
  });

  it('EXECUTE requires exact Owner ACK and ready PLAN; starts once', async () => {
    expect(() => assertPhase21Gen2TemporalLaunchAck('WRONG')).toThrow(/OWNER_ACK/);
    assertPhase21Gen2TemporalLaunchAck(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK);

    const start = vi.fn(async () => ({ firstExecutionRunId: 'run-1' }));
    const plan: Phase21Gen2TemporalLaunchPlanResult = {
      ok: true,
      mode: 'PLAN',
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      publicId: 'WD-000001',
      workflowId: `withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`,
      readyForExecute: true,
      checks: [],
      gen1PermitStatus: 'CONSUMED',
      gen1ConsumedAttemptId: 'attempt-1',
      gen2PermitId: 'permit-2',
      gen2PermitStatus: 'ARMED',
      attemptCount: 1,
      reservationHeld: true,
      globalRelayEnabled: false,
      startOptions: buildPhase21Gen2TemporalLaunchStartOptions({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        taskQueue: 'tq',
      }),
      broadcastPerformed: false,
      signed: false,
      mutated: false,
      relayEnabled: false,
    };

    const refused = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: 'NOPE',
      plan,
      temporal: { workflow: { start } },
    });
    expect(refused.started).toBe(false);
    expect(start).not.toHaveBeenCalled();

    const ok = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
    });
    expect(ok).toMatchObject({
      ok: true,
      started: true,
      runId: 'run-1',
      relayEnabled: false,
      signed: false,
      broadcastPerformed: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![1]).toMatchObject({
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
    });
  });
});

