/**
 * Phase 21 Gen-2 Temporal launch — pure gate + EXECUTE unit tests (no production).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
} from '../src/phase21-canary-payout-plan.js';
import { mintPhase21Gen2IndependentChainReconciliationForTests } from '../src/phase21-gen2-recovery-plan.js';
import {
  assertPhase21Gen2TemporalLaunchAck,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
  buildPhase21Gen2TemporalLaunchStartOptions,
  evaluatePhase21Gen2DurableGen1TerminalEvidence,
  evaluatePhase21Gen2LiveDeployShaMatch,
  evaluatePhase21Gen2PriorWorkflowIdentity,
  evaluatePhase21Gen2TemporalLaunchEligibility,
  executePhase21Gen2TemporalLaunch,
  PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY,
  type Phase21Gen2DurableGen1TerminalEvidence,
  type Phase21Gen2TemporalLaunchPlanResult,
} from '../src/phase21-gen2-temporal-launch.js';
import { evaluatePhase21CanaryFailedPreZeroAttemptRecovery } from '../src/phase21-resume-canary-gates.js';

const GEN1_RUN_ID = '01a13154-dc13-739c-92d1-8579627cc06e';
const GEN2_RUN_ID = '01a2bbbb-cccc-dddd-eeee-ffffffffffff';
const GEN2_PERMIT_ID = '6760fcfe-f6eb-41f9-aef9-a2a969fd04ed';
const DURABLE_OK: Phase21Gen2DurableGen1TerminalEvidence = {
  gen1PermitStatus: 'CONSUMED',
  gen1ConsumedAttemptId: 'attempt-1',
  attemptCount: 1,
  failedPreAttemptCount: 1,
  broadcastEvidenceCount: 0,
  gen2PermitStatus: 'ARMED',
  gen2TemporalLaunchClaimAbsent: true,
};

function mockClaimClient(options?: { readonly insertReturnsId?: boolean }) {
  const insertReturnsId = options?.insertReturnsId ?? true;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM feature_flags') && sql.includes('PAYOUT_DISPATCH_PAUSE')) {
        return { rows: [{ enabled: true }] };
      }
      if (sql.includes('FROM withdrawals') && sql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              id: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
              public_id: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
              state: 'FAILED_PRE_BROADCAST',
              reservation_ledger_tx_id: 'res-1',
              settlement_ledger_tx_id: null,
              release_ledger_tx_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM phase21_manual_dispatch_permits') && sql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              id: 'permit-gen1',
              authorization_generation: 1,
              status: 'CONSUMED',
              consumed_attempt_id: 'attempt-1',
            },
            {
              id: GEN2_PERMIT_ID,
              authorization_generation: 2,
              status: 'ARMED',
              consumed_attempt_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM withdrawal_attempts') && sql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              attempt_number: 1,
              broadcast_result_state: 'FAILED_PRE_BROADCAST',
              has_evidence: false,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO outbox_events')) {
        return { rows: insertReturnsId ? [{ id: 'claim-1' }] : [] };
      }
      return { rows: [] };
    }),
  };
}

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
    expectedGen1RunId: GEN1_RUN_ID,
    priorWorkflowFound: true,
    observedPriorRunId: GEN1_RUN_ID,
    priorWorkflowStatus: 'COMPLETED',
    workflowStillRunning: false,
  };

  it('eligible when Gen-2 ARMED + Gen-1 CONSUMED + FAILED_PRE #1 + Gen-1 run identity + gates pass', () => {
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

  it('EXECUTE requires exact Owner ACK, durable claim, and ready PLAN; starts once', async () => {
    expect(() => assertPhase21Gen2TemporalLaunchAck('WRONG')).toThrow(/OWNER_ACK/);
    assertPhase21Gen2TemporalLaunchAck(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK);

    const start = vi.fn(
      async (_workflowType: string, opts: Record<string, unknown>) => {
        void opts;
        return { firstExecutionRunId: 'run-1' };
      },
    );
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
      gen2PermitId: GEN2_PERMIT_ID,
      gen2PermitStatus: 'ARMED',
      attemptCount: 1,
      reservationHeld: true,
      globalRelayEnabled: false,
      priorWorkflowIdentityMode: 'live_gen1_run',
      startOptions: buildPhase21Gen2TemporalLaunchStartOptions({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        taskQueue: 'tq',
      }),
      broadcastPerformed: false,
      signed: false,
      mutated: false,
      relayEnabled: false,
    };
    const chainReconciliation = mintPhase21Gen2IndependentChainReconciliationForTests();

    const claimClient = mockClaimClient();

    const refused = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: 'NOPE',
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen1RunId: GEN1_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(refused.started).toBe(false);
    expect(start).not.toHaveBeenCalled();

    const ok = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen1RunId: GEN1_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
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
    expect(
      claimClient.query.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('FROM withdrawals') && c[0].includes('FOR UPDATE'),
      ),
    ).toBe(true);

    const conflictClient = mockClaimClient({ insertReturnsId: false });
    const claimed = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: conflictClient as never,
      expectedGen1RunId: GEN1_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(claimed).toMatchObject({ started: false, refuseCode: 'GEN2_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('EXECUTE refuses when claim-txn revalidation fails (stale recon / pause off)', async () => {
    const start = vi.fn(
      async (_workflowType: string, opts: Record<string, unknown>) => {
        void opts;
        return { firstExecutionRunId: 'run-1' };
      },
    );
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
      gen2PermitId: GEN2_PERMIT_ID,
      gen2PermitStatus: 'ARMED',
      attemptCount: 1,
      reservationHeld: true,
      globalRelayEnabled: false,
      priorWorkflowIdentityMode: 'live_gen1_run',
      startOptions: buildPhase21Gen2TemporalLaunchStartOptions({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        taskQueue: 'tq',
      }),
      broadcastPerformed: false,
      signed: false,
      mutated: false,
      relayEnabled: false,
    };
    const stale = mintPhase21Gen2IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const claimClient = mockClaimClient();
    const refused = await executePhase21Gen2TemporalLaunch({
      confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen1RunId: GEN1_RUN_ID,
      chainReconciliation: stale,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(refused).toMatchObject({
      started: false,
      refuseCode: 'CLAIM_CHAIN_RECON_CHAIN_RECON_STALE_OR_FUTURE',
    });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('phase21 Gen-2 prior workflow one-shot identity', () => {
  it('refuses missing prior workflow without durable evidence (never assume COMPLETED)', () => {
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: false },
      }),
    ).toEqual({
      ok: false,
      reason: 'prior_workflow_not_found',
      priorWorkflowStatus: null,
      observedRunId: null,
      identityMode: null,
    });
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
        expectedGen1RunId: GEN1_RUN_ID,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: 'COMPLETED', // must not open the gate when history is missing
        workflowStillRunning: false,
      }).reason,
    ).toBe('prior_workflow_not_found');
  });

  it('accepts durable Gen-1 terminal evidence when Temporal history is absent', () => {
    expect(evaluatePhase21Gen2DurableGen1TerminalEvidence(DURABLE_OK)).toEqual({
      ok: true,
      reason: null,
    });
    expect(
      evaluatePhase21Gen2DurableGen1TerminalEvidence({
        ...DURABLE_OK,
        broadcastEvidenceCount: 1,
      }).reason,
    ).toBe('durable_broadcast_evidence_exists');
    expect(
      evaluatePhase21Gen2DurableGen1TerminalEvidence({
        ...DURABLE_OK,
        gen2TemporalLaunchClaimAbsent: false,
      }).reason,
    ).toBe('durable_gen2_launch_already_claimed');

    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: false },
        durableGen1Terminal: DURABLE_OK,
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: 'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN1_TERMINAL',
      observedRunId: null,
      identityMode: 'durable_gen1_terminal',
    });

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
        expectedGen1RunId: GEN1_RUN_ID,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: '',
        workflowStillRunning: false,
        durableGen1Terminal: DURABLE_OK,
      }),
    ).toEqual({ eligible: true, reason: null });

    expect(
      buildPhase21Gen2TemporalLaunchClaimDedupeKey({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        gen2PermitId: '6760fcfe-f6eb-41f9-aef9-a2a969fd04ed',
      }),
    ).toBe(
      `withdrawal.phase21_gen2_temporal_launch:${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}:6760fcfe-f6eb-41f9-aef9-a2a969fd04ed`,
    );
  });

  it('accepts correct Gen-1 prior run identity', () => {
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: true, runId: GEN1_RUN_ID, status: 'COMPLETED' },
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: 'COMPLETED',
      observedRunId: GEN1_RUN_ID,
      identityMode: 'live_gen1_run',
    });
  });

  it('refuses already-launched Gen-2 including after COMPLETED (sequential re-launch)', () => {
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: true, runId: GEN2_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('gen2_already_launched_or_run_mismatch');
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: true, runId: GEN2_RUN_ID, status: 'RUNNING' },
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
        expectedGen1RunId: GEN1_RUN_ID,
        priorWorkflowFound: true,
        observedPriorRunId: GEN2_RUN_ID,
        priorWorkflowStatus: 'COMPLETED',
        workflowStillRunning: false,
      }).reason,
    ).toBe('gen2_already_launched_or_run_mismatch');
  });

  it('refuses missing/ambiguous expected or observed run identity', () => {
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: '',
        observation: { found: true, runId: GEN1_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('expected_gen1_run_id_missing');
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: true, runId: null, status: 'COMPLETED' },
      }).reason,
    ).toBe('prior_run_id_ambiguous');
    expect(
      evaluatePhase21Gen2PriorWorkflowIdentity({
        expectedGen1RunId: GEN1_RUN_ID,
        observation: { found: true, runId: '   ', status: 'COMPLETED' },
      }).reason,
    ).toBe('prior_run_id_ambiguous');
  });

  it('concurrent launch: RUNNING refused even when Gen-1 runId still matches', () => {
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
        expectedGen1RunId: GEN1_RUN_ID,
        priorWorkflowFound: true,
        observedPriorRunId: GEN1_RUN_ID,
        priorWorkflowStatus: 'RUNNING',
        workflowStillRunning: true,
      }).reason,
    ).toBe('workflow_still_running');
  });
});
