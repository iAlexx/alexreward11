/**
 * Phase 21 Gen-3 Temporal launch - pure gate + EXECUTE unit tests (no production).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
} from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen2-temporal-launch.js';
import {
  PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
  mintPhase21Gen3IndependentChainReconciliationForTests,
} from '../src/phase21-gen3-recovery-plan.js';
import {
  assertPhase21Gen3TemporalLaunchAck,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  buildPhase21Gen3TemporalLaunchStartOptions,
  evaluatePhase21Gen3DurableGen2TerminalEvidence,
  evaluatePhase21Gen3LiveDeployShaMatch,
  evaluatePhase21Gen3PriorWorkflowIdentity,
  evaluatePhase21Gen3TemporalLaunchEligibility,
  executePhase21Gen3TemporalLaunch,
  PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  PHASE21_GEN3_TEMPORAL_LAUNCH_REUSE_POLICY,
  type Phase21Gen3DurableGen2TerminalEvidence,
  type Phase21Gen3TemporalLaunchPlanResult,
} from '../src/phase21-gen3-temporal-launch.js';

const GEN1_RUN_ID = '01a13154-dc13-739c-92d1-8579627cc06e';
const GEN2_RUN_ID = '01a2bbbb-cccc-dddd-eeee-ffffffffffff';
const GEN3_RUN_ID = '01a3cccc-dddd-eeee-ffff-000000000000';
const GEN1_PERMIT_ID = '11111111-1111-4111-8111-111111111111';
const GEN2_PERMIT_ID = '6760fcfe-f6eb-41f9-aef9-a2a969fd04ed';
const GEN3_PERMIT_ID = '33333333-3333-4333-8333-333333333333';

const DURABLE_OK: Phase21Gen3DurableGen2TerminalEvidence = {
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
};

function mockClaimClient(options?: {
  readonly insertReturnsId?: boolean;
  readonly gen2ClaimPresent?: boolean;
  readonly attempt2HasEvidence?: boolean;
  readonly attemptRows?: ReadonlyArray<{
    attempt_number: number;
    broadcast_result_state: string;
    has_evidence: boolean;
  }>;
  readonly gen2Status?: string;
  readonly gen3Status?: string;
  readonly gen3Id?: string;
}) {
  const insertReturnsId = options?.insertReturnsId ?? true;
  const gen2ClaimPresent = options?.gen2ClaimPresent ?? true;
  const attemptRows = options?.attemptRows ?? [
    { attempt_number: 1, broadcast_result_state: 'FAILED_PRE_BROADCAST', has_evidence: false },
    {
      attempt_number: 2,
      broadcast_result_state: 'FAILED_PRE_BROADCAST',
      has_evidence: options?.attempt2HasEvidence ?? false,
    },
  ];
  let insertedOnce = false;
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      void params;
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
              id: GEN1_PERMIT_ID,
              authorization_generation: 1,
              status: 'CONSUMED',
              consumed_attempt_id: 'attempt-1',
            },
            {
              id: GEN2_PERMIT_ID,
              authorization_generation: 2,
              status: options?.gen2Status ?? 'CONSUMED',
              consumed_attempt_id: (options?.gen2Status ?? 'CONSUMED') === 'CONSUMED' ? 'attempt-2' : null,
            },
            {
              id: options?.gen3Id ?? GEN3_PERMIT_ID,
              authorization_generation: 3,
              status: options?.gen3Status ?? 'ARMED',
              consumed_attempt_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM outbox_events') && sql.includes('DISPATCHED')) {
        return { rows: [{ n: gen2ClaimPresent ? 1 : 0 }] };
      }
      if (sql.includes('FROM withdrawal_attempts') && sql.includes('FOR UPDATE')) {
        return { rows: [...attemptRows] };
      }
      if (sql.includes('INSERT INTO outbox_events')) {
        if (!insertReturnsId) return { rows: [] };
        if (insertedOnce) return { rows: [] }; // unique dedupe_key: second insert conflicts
        insertedOnce = true;
        return { rows: [{ id: 'claim-gen3-1' }] };
      }
      return { rows: [] };
    }),
  };
}

function readyPlan(overrides?: Partial<Phase21Gen3TemporalLaunchPlanResult>): Phase21Gen3TemporalLaunchPlanResult {
  return {
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
    gen2PermitStatus: 'CONSUMED',
    gen2ConsumedAttemptId: 'attempt-2',
    gen2TemporalLaunchClaimPresent: true,
    gen3PermitId: GEN3_PERMIT_ID,
    gen3PermitStatus: 'ARMED',
    attemptCount: 2,
    reservationHeld: true,
    globalRelayEnabled: false,
    priorWorkflowIdentityMode: 'live_gen2_run',
    startOptions: buildPhase21Gen3TemporalLaunchStartOptions({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      taskQueue: 'tq',
    }),
    broadcastPerformed: false,
    signed: false,
    mutated: false,
    relayEnabled: false,
    ...overrides,
  };
}

const baseEligibility = {
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
  expectedGen2RunId: GEN2_RUN_ID,
  priorWorkflowFound: true,
  observedPriorRunId: GEN2_RUN_ID,
  priorWorkflowStatus: 'COMPLETED',
  workflowStillRunning: false,
};

describe('phase21 Gen-3 Temporal launch constants', () => {
  it('ACK / claim event / dedupe key are Gen-3 specific and distinct from Gen-2', () => {
    expect(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK).toBe('I_AUTHORIZE_WD_000001_GEN3_TEMPORAL_ONE_SHOT');
    expect(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK).not.toBe(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK);
    expect(PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE).toBe('phase21.gen3_temporal_launch_claim');
    expect(PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE).not.toBe(
      PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
    );
    const key = buildPhase21Gen3TemporalLaunchClaimDedupeKey({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      gen3PermitId: GEN3_PERMIT_ID,
    });
    expect(key).toBe(
      `withdrawal.phase21_gen3_temporal_launch:${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}:${GEN3_PERMIT_ID}`,
    );
    expect(key).not.toBe(
      buildPhase21Gen2TemporalLaunchClaimDedupeKey({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        gen2PermitId: GEN3_PERMIT_ID,
      }),
    );
  });

  it('start options freeze ALLOW_DUPLICATE + FAIL + realChainEnabled', () => {
    const opts = buildPhase21Gen3TemporalLaunchStartOptions({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      taskQueue: 'alex-rewards-worker',
    });
    expect(opts.workflowIdReusePolicy).toBe(PHASE21_GEN3_TEMPORAL_LAUNCH_REUSE_POLICY);
    expect(opts.workflowIdConflictPolicy).toBe(PHASE21_GEN3_TEMPORAL_LAUNCH_CONFLICT_POLICY);
    expect(opts.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE');
    expect(opts.workflowIdConflictPolicy).toBe('FAIL');
    expect(opts.workflowType).toBe('withdrawalPayoutWorkflow');
    expect(opts.args[0].realChainEnabled).toBe(true);
    expect(opts.workflowId).toBe(`withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`);
  });

  it('deploy SHA match accepts full or prefix equality', () => {
    expect(
      evaluatePhase21Gen3LiveDeployShaMatch({
        expectedDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
        liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen3LiveDeployShaMatch({
        expectedDeploySha: 'd427269',
        liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen3LiveDeployShaMatch({
        expectedDeploySha: 'aaaaaaaa',
        liveDeploySha: 'd427269',
      }).reason,
    ).toBe('deploy_sha_mismatch');
    expect(
      evaluatePhase21Gen3LiveDeployShaMatch({ expectedDeploySha: '', liveDeploySha: 'd427269' })
        .reason,
    ).toBe('expected_deploy_sha_invalid');
  });
});

describe('phase21 Gen-3 Temporal launch gates', () => {
  it('eligible when Gen-3 ARMED + Gen-1/Gen-2 CONSUMED + two FAILED_PRE + Gen-2 run identity + gates pass', () => {
    expect(evaluatePhase21Gen3TemporalLaunchEligibility(baseEligibility)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it('refuses global relay ON / deploy SHA / signer / running workflow / evidence / claim missing', () => {
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, globalRelayEnabled: true })
        .reason,
    ).toBe('global_relay_must_remain_off');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, deployShaOk: false }).reason,
    ).toBe('deploy_sha_mismatch');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, signerReady: false }).reason,
    ).toBe('signer_not_ready');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, signerUnlocked: false })
        .reason,
    ).toBe('signer_not_ready');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        workflowStillRunning: true,
      }).reason,
    ).toBe('workflow_still_running');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, chainReconOk: false })
        .reason,
    ).toBe('chain_recon_required');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        broadcastEvidenceCount: 1,
      }).reason,
    ).toBe('broadcast_evidence_exists');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        gen2TemporalLaunchClaimPresent: false,
      }).reason,
    ).toBe('gen2_launch_claim_missing');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({ ...baseEligibility, settlementPresent: true })
        .reason,
    ).toBe('already_settled');
  });

  it('refuses Gen-2 shapes: one attempt, Gen-2 still ARMED, Gen-3 not armed', () => {
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        attemptCount: 1,
        failedPreAttemptCount: 1,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        gen2PermitStatus: 'ARMED',
      }).reason,
    ).toBe('gen2_not_consumed');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        gen3PermitStatus: 'CONSUMED',
      }).reason,
    ).toBe('gen3_not_armed');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        attemptCount: 3,
        failedPreAttemptCount: 3,
      }).reason,
    ).toBe('prior_attempt_count_not_two');
  });

  it('concurrent launch: RUNNING refused even when Gen-2 runId still matches', () => {
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        priorWorkflowStatus: 'RUNNING',
        workflowStillRunning: true,
      }).reason,
    ).toBe('workflow_still_running');
  });
});

describe('phase21 Gen-3 prior workflow one-shot identity (binds to Gen-2 run)', () => {
  it('accepts correct Gen-2 prior run identity; refuses Gen-1 run id', () => {
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: GEN2_RUN_ID, status: 'COMPLETED' },
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: 'COMPLETED',
      observedRunId: GEN2_RUN_ID,
      identityMode: 'live_gen2_run',
    });
    // Live run is still the Gen-1 run => the Gen-2 launch never happened; refuse.
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: GEN1_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('gen3_already_launched_or_run_mismatch');
  });

  it('refuses already-launched Gen-3 including after COMPLETED (sequential re-launch)', () => {
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: GEN3_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('gen3_already_launched_or_run_mismatch');
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: GEN3_RUN_ID, status: 'RUNNING' },
      }).reason,
    ).toBe('gen3_already_launched_or_run_mismatch');
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        observedPriorRunId: GEN3_RUN_ID,
      }).reason,
    ).toBe('gen3_already_launched_or_run_mismatch');
  });

  it('refuses missing/ambiguous expected or observed run identity', () => {
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: '',
        observation: { found: true, runId: GEN2_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('expected_gen2_run_id_missing');
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: null, status: 'COMPLETED' },
      }).reason,
    ).toBe('prior_run_id_ambiguous');
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: true, runId: '   ', status: 'COMPLETED' },
      }).reason,
    ).toBe('prior_run_id_ambiguous');
  });

  it('refuses missing prior workflow without durable evidence (never assume COMPLETED)', () => {
    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
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
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: 'COMPLETED', // must not open the gate when history is missing
      }).reason,
    ).toBe('prior_workflow_not_found');
  });

  it('accepts durable Gen-2 terminal evidence when Temporal history is absent (expired retention)', () => {
    expect(evaluatePhase21Gen3DurableGen2TerminalEvidence(DURABLE_OK)).toEqual({
      ok: true,
      reason: null,
    });
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({ ...DURABLE_OK, gen1PermitStatus: 'ARMED' })
        .reason,
    ).toBe('durable_gen1_not_consumed');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({ ...DURABLE_OK, gen2PermitStatus: 'ARMED' })
        .reason,
    ).toBe('durable_gen2_not_consumed');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({
        ...DURABLE_OK,
        gen2ConsumedAttemptId: null,
      }).reason,
    ).toBe('durable_gen2_attempt_unbound');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({
        ...DURABLE_OK,
        gen2ConsumedAttemptId: 'attempt-1',
      }).reason,
    ).toBe('durable_gen2_attempt_same_as_gen1');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({
        ...DURABLE_OK,
        attemptCount: 1,
        failedPreAttemptCount: 1,
      }).reason,
    ).toBe('durable_attempt_shape_refused');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({ ...DURABLE_OK, broadcastEvidenceCount: 1 })
        .reason,
    ).toBe('durable_broadcast_evidence_exists');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({
        ...DURABLE_OK,
        gen2TemporalLaunchClaimPresent: false,
      }).reason,
    ).toBe('durable_gen2_launch_claim_missing');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({ ...DURABLE_OK, gen3PermitStatus: 'CONSUMED' })
        .reason,
    ).toBe('durable_gen3_not_armed');
    expect(
      evaluatePhase21Gen3DurableGen2TerminalEvidence({
        ...DURABLE_OK,
        gen3TemporalLaunchClaimAbsent: false,
      }).reason,
    ).toBe('durable_gen3_launch_already_claimed');

    expect(
      evaluatePhase21Gen3PriorWorkflowIdentity({
        expectedGen2RunId: GEN2_RUN_ID,
        observation: { found: false },
        durableGen2Terminal: DURABLE_OK,
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
      observedRunId: null,
      identityMode: 'durable_gen2_terminal',
    });

    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: '',
        durableGen2Terminal: DURABLE_OK,
      }),
    ).toEqual({ eligible: true, reason: null });

    // Durable evidence is ignored when live history exists (live runId wins).
    expect(
      evaluatePhase21Gen3TemporalLaunchEligibility({
        ...baseEligibility,
        observedPriorRunId: GEN3_RUN_ID,
        durableGen2Terminal: DURABLE_OK,
      }).reason,
    ).toBe('gen3_already_launched_or_run_mismatch');
  });
});

describe('phase21 Gen-3 Temporal launch EXECUTE', () => {
  function startMock() {
    return vi.fn(async (_workflowType: string, opts: Record<string, unknown>) => {
      void opts;
      return { firstExecutionRunId: 'run-gen3' };
    });
  }

  it('requires exact Owner ACK, durable claim, and ready PLAN; starts once; second request refused', async () => {
    expect(() => assertPhase21Gen3TemporalLaunchAck('WRONG')).toThrow(/OWNER_ACK/);
    expect(() => assertPhase21Gen3TemporalLaunchAck(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK)).toThrow(
      /OWNER_ACK/,
    );
    assertPhase21Gen3TemporalLaunchAck(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK);

    const start = startMock();
    const plan = readyPlan();
    const chainReconciliation = mintPhase21Gen3IndependentChainReconciliationForTests();
    const claimClient = mockClaimClient();

    const refused = await executePhase21Gen3TemporalLaunch({
      confirmationPhrase: PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen2RunId: GEN2_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(refused).toMatchObject({ started: false, refuseCode: 'OWNER_ACK_REQUIRED' });
    expect(start).not.toHaveBeenCalled();

    const ok = await executePhase21Gen3TemporalLaunch({
      confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen2RunId: GEN2_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(ok).toMatchObject({
      ok: true,
      started: true,
      runId: 'run-gen3',
      relayEnabled: false,
      signed: false,
      broadcastPerformed: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![1]).toMatchObject({
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
      args: [{ withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID, realChainEnabled: true }],
    });
    const sqls = claimClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('FROM withdrawals') && s.includes('FOR UPDATE'))).toBe(true);
    expect(
      sqls.some((s) => s.includes('FROM phase21_manual_dispatch_permits') && s.includes('FOR UPDATE')),
    ).toBe(true);
    expect(sqls.some((s) => s.includes('FROM withdrawal_attempts') && s.includes('FOR UPDATE'))).toBe(
      true,
    );
    const insertCall = claimClient.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO outbox_events'),
    );
    expect(insertCall?.[1]).toEqual([
      PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
      expect.stringContaining('"gen3PermitId"'),
      buildPhase21Gen3TemporalLaunchClaimDedupeKey({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        gen3PermitId: GEN3_PERMIT_ID,
      }),
    ]);
    expect(String(insertCall?.[0])).toContain("'DISPATCHED'::outbox_event_status");

    // Repeated Owner request on the same DB: unique dedupe_key refuses; no second start.
    const again = await executePhase21Gen3TemporalLaunch({
      confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen2RunId: GEN2_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(again).toMatchObject({ started: false, refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).toHaveBeenCalledTimes(1);

    const conflictClient = mockClaimClient({ insertReturnsId: false });
    const claimed = await executePhase21Gen3TemporalLaunch({
      confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: conflictClient as never,
      expectedGen2RunId: GEN2_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(claimed).toMatchObject({ started: false, refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('refuses PLAN not ready / relay ON / missing Gen-3 permit / Gen-2 claim missing / permit reuse before any claim', async () => {
    const start = startMock();
    const claimClient = mockClaimClient();
    const chainReconciliation = mintPhase21Gen3IndependentChainReconciliationForTests();
    const run = (plan: Phase21Gen3TemporalLaunchPlanResult) =>
      executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: claimClient as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation,
        deploymentEnvironment: 'PRODUCTION',
      });

    expect(await run(readyPlan({ ok: false, readyForExecute: false }))).toMatchObject({
      refuseCode: 'PLAN_NOT_READY',
    });
    expect(await run(readyPlan({ startOptions: null }))).toMatchObject({
      refuseCode: 'PLAN_NOT_READY',
    });
    expect(await run(readyPlan({ globalRelayEnabled: true }))).toMatchObject({
      refuseCode: 'GLOBAL_RELAY_MUST_REMAIN_OFF',
    });
    expect(await run(readyPlan({ gen3PermitId: null }))).toMatchObject({
      refuseCode: 'GEN3_PERMIT_ID_REQUIRED',
    });
    expect(await run(readyPlan({ gen3PermitId: GEN2_PERMIT_ID }))).toMatchObject({
      refuseCode: 'GEN3_PRIOR_PERMIT_REUSE_REFUSED',
    });
    expect(await run(readyPlan({ gen2TemporalLaunchClaimPresent: false }))).toMatchObject({
      refuseCode: 'GEN2_LAUNCH_CLAIM_MISSING',
    });
    expect(start).not.toHaveBeenCalled();
    expect(claimClient.query).not.toHaveBeenCalled();
  });

  it('refuses when claim-txn revalidation fails (stale / UNKNOWN recon, Gen-2 claim missing, attempt shape, Gen-2 ARMED)', async () => {
    const start = startMock();
    const plan = readyPlan();
    const fresh = mintPhase21Gen3IndependentChainReconciliationForTests();

    const stale = mintPhase21Gen3IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient() as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: stale,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({
      started: false,
      refuseCode: 'CLAIM_CHAIN_RECON_CHAIN_RECON_STALE_OR_FUTURE',
    });

    // Chain state UNKNOWN (non-HIGH confidence) is a refusal, never a blind retry.
    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient() as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: { ...fresh, confidence: 'UNKNOWN' as unknown as 'HIGH' },
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_CHAIN_RECON_CONFIDENCE_NOT_HIGH' });

    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({ gen2ClaimPresent: false }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_GEN2_LAUNCH_CLAIM_MISSING' });

    // Signed-but-lost with persisted evidence on attempt #2 => refuse (reconcile, never retry).
    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({ attempt2HasEvidence: true }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' });

    // Only one attempt (Gen-2 never ran) => refuse.
    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({
          attemptRows: [
            { attempt_number: 1, broadcast_result_state: 'FAILED_PRE_BROADCAST', has_evidence: false },
          ],
        }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' });

    // Three attempts already => refuse (Gen-3 is one authorized attempt #3 only).
    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({
          attemptRows: [
            { attempt_number: 1, broadcast_result_state: 'FAILED_PRE_BROADCAST', has_evidence: false },
            { attempt_number: 2, broadcast_result_state: 'FAILED_PRE_BROADCAST', has_evidence: false },
            { attempt_number: 3, broadcast_result_state: 'FAILED_PRE_BROADCAST', has_evidence: false },
          ],
        }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' });

    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({ gen2Status: 'ARMED' }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_GEN2_NOT_CONSUMED' });

    expect(
      await executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start } },
        claimClient: mockClaimClient({ gen3Status: 'CONSUMED' }) as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation: fresh,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_GEN3_NOT_ARMED' });

    expect(start).not.toHaveBeenCalled();
  });

  it('service restart after claim: Temporal start failure keeps the claim; retry is refused, never re-started blindly', async () => {
    const plan = readyPlan();
    const chainReconciliation = mintPhase21Gen3IndependentChainReconciliationForTests();
    const claimClient = mockClaimClient();
    const failingStart = vi.fn(async () => {
      throw new Error('TEMPORAL_UNAVAILABLE_AFTER_CLAIM');
    });

    await expect(
      executePhase21Gen3TemporalLaunch({
        confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
        plan,
        temporal: { workflow: { start: failingStart } },
        claimClient: claimClient as never,
        expectedGen2RunId: GEN2_RUN_ID,
        chainReconciliation,
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).rejects.toThrow(/TEMPORAL_UNAVAILABLE_AFTER_CLAIM/);
    expect(failingStart).toHaveBeenCalledTimes(1);
    const sqls = claimClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(1);
    // Claim committed before the start; nothing deletes/clears it afterwards.
    expect(sqls.some((s) => /DELETE|UPDATE outbox_events/i.test(s))).toBe(false);

    // After "restart", the Owner retries: the durable claim refuses a second launch.
    const start = startMock();
    const retried = await executePhase21Gen3TemporalLaunch({
      confirmationPhrase: PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
      plan,
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen2RunId: GEN2_RUN_ID,
      chainReconciliation,
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(retried).toMatchObject({ started: false, refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).not.toHaveBeenCalled();
  });
});
