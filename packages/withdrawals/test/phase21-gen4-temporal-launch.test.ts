/**
 * Phase 21 Gen-4 Temporal launch - pure gate + PLAN + EXECUTE unit tests (no production,
 * no Temporal server, no PostgreSQL). PLAN / claim revalidation run against the in-memory
 * SQL-pattern mock in phase21-gen4-mock-db.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID } from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
} from '../src/phase21-gen2-temporal-launch.js';
import {
  PHASE21_GEN3_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen3-temporal-launch.js';
import {
  PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS,
  mintPhase21Gen4IndependentChainReconciliationForTests,
} from '../src/phase21-gen4-recovery-plan.js';
import {
  PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  PHASE21_GEN4_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  PHASE21_GEN4_TEMPORAL_LAUNCH_REUSE_POLICY,
  assertPhase21Gen4TemporalLaunchAck,
  buildPhase21Gen4TemporalLaunchClaimDedupeKey,
  buildPhase21Gen4TemporalLaunchStartOptions,
  evaluatePhase21Gen4DurableGen3TerminalEvidence,
  evaluatePhase21Gen4LiveDeployShaMatch,
  evaluatePhase21Gen4PriorWorkflowIdentity,
  evaluatePhase21Gen4TemporalLaunchEligibility,
  executePhase21Gen4TemporalLaunch,
  planPhase21Gen4TemporalLaunch,
  type Phase21Gen4DurableGen3TerminalEvidence,
  type Phase21Gen4TemporalLaunchPlanResult,
} from '../src/phase21-gen4-temporal-launch.js';
import {
  GEN1_PERMIT_ID,
  GEN2_PERMIT_ID,
  GEN3_PERMIT_ID,
  GEN4_PERMIT_ID,
  WID,
  createGen4World,
  gen3ClaimKey,
  gen3ClaimPayload,
  mockGen4Client,
  type Gen4MockWorld,
} from './phase21-gen4-mock-db.js';

const GEN1_RUN_ID = '01a13154-dc13-739c-92d1-8579627cc06e';
const GEN2_RUN_ID = '01a2bbbb-cccc-dddd-eeee-ffffffffffff';
const GEN3_RUN_ID = '01a3cccc-dddd-eeee-ffff-000000000000';
const GEN4_RUN_ID = '01a4dddd-eeee-ffff-0000-111111111111';

const DURABLE_OK: Phase21Gen4DurableGen3TerminalEvidence = {
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
};

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
  expectedGen3RunId: GEN3_RUN_ID,
  priorWorkflowFound: true,
  observedPriorRunId: GEN3_RUN_ID,
  priorWorkflowStatus: 'COMPLETED',
  workflowStillRunning: false,
};

function readyPlan(
  overrides?: Partial<Phase21Gen4TemporalLaunchPlanResult>,
): Phase21Gen4TemporalLaunchPlanResult {
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
    gen3PermitStatus: 'CONSUMED',
    gen3ConsumedAttemptId: 'attempt-3',
    gen3TemporalLaunchClaimBound: true,
    gen4PermitId: GEN4_PERMIT_ID,
    gen4PermitStatus: 'ARMED',
    attemptCount: 3,
    reservationHeld: true,
    globalRelayEnabled: false,
    priorWorkflowIdentityMode: 'live_gen3_run',
    startOptions: buildPhase21Gen4TemporalLaunchStartOptions({
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

describe('phase21 Gen-4 Temporal launch constants', () => {
  it('ACK / claim event / dedupe key are Gen-4 specific and distinct from Gen-2 / Gen-3', () => {
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK).toBe('I_AUTHORIZE_WD_000001_GEN4_TEMPORAL_ONE_SHOT');
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK).not.toBe(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK);
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK).not.toBe(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK);
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE).toBe('phase21.gen4_temporal_launch_claim');
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE).not.toBe(
      PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
    );
    expect(PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE).not.toBe(
      PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
    );
    const key = buildPhase21Gen4TemporalLaunchClaimDedupeKey({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      gen4PermitId: GEN4_PERMIT_ID,
    });
    expect(key).toBe(
      `withdrawal.phase21_gen4_temporal_launch:${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}:${GEN4_PERMIT_ID}`,
    );
    expect(key).not.toBe(
      buildPhase21Gen3TemporalLaunchClaimDedupeKey({
        withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        gen3PermitId: GEN4_PERMIT_ID,
      }),
    );
  });

  it('start options freeze ALLOW_DUPLICATE + FAIL + realChainEnabled', () => {
    const opts = buildPhase21Gen4TemporalLaunchStartOptions({
      withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      taskQueue: 'alex-rewards-worker',
    });
    expect(opts.workflowIdReusePolicy).toBe(PHASE21_GEN4_TEMPORAL_LAUNCH_REUSE_POLICY);
    expect(opts.workflowIdConflictPolicy).toBe(PHASE21_GEN4_TEMPORAL_LAUNCH_CONFLICT_POLICY);
    expect(opts.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE');
    expect(opts.workflowIdConflictPolicy).toBe('FAIL');
    expect(opts.workflowType).toBe('withdrawalPayoutWorkflow');
    expect(opts.args[0].realChainEnabled).toBe(true);
    expect(opts.workflowId).toBe(`withdrawal/${PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID}`);
    // maximumAttempts stays in the workflow definition (not overridable from the launcher).
    expect(Object.keys(opts)).not.toContain('retry');
    expect(JSON.stringify(opts)).not.toContain('maximumAttempts');
  });

  it('deploy SHA match accepts full or prefix equality and refuses mismatches', () => {
    expect(
      evaluatePhase21Gen4LiveDeployShaMatch({
        expectedDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
        liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen4LiveDeployShaMatch({
        expectedDeploySha: 'd427269',
        liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
      }).ok,
    ).toBe(true);
    expect(
      evaluatePhase21Gen4LiveDeployShaMatch({ expectedDeploySha: 'aaaaaaaa', liveDeploySha: 'd427269' })
        .reason,
    ).toBe('deploy_sha_mismatch');
    expect(
      evaluatePhase21Gen4LiveDeployShaMatch({ expectedDeploySha: '', liveDeploySha: 'd427269' }).reason,
    ).toBe('expected_deploy_sha_invalid');
  });

  it('ACK assertion accepts only the Gen-4 phrase', () => {
    expect(() => assertPhase21Gen4TemporalLaunchAck('WRONG')).toThrow(/OWNER_ACK/);
    expect(() => assertPhase21Gen4TemporalLaunchAck(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK)).toThrow(
      /OWNER_ACK/,
    );
    expect(() => assertPhase21Gen4TemporalLaunchAck(PHASE21_GEN2_TEMPORAL_LAUNCH_ACK)).toThrow(
      /OWNER_ACK/,
    );
    expect(() => assertPhase21Gen4TemporalLaunchAck(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK)).not.toThrow();
  });
});

describe('phase21 Gen-4 Temporal launch eligibility gates', () => {
  it('eligible when Gen-4 ARMED + Gen-1/2/3 CONSUMED + bound Gen-3 claim + three FAILED_PRE + Gen-3 run identity', () => {
    expect(evaluatePhase21Gen4TemporalLaunchEligibility(baseEligibility)).toEqual({
      eligible: true,
      reason: null,
    });
  });

  it.each([
    ['global relay ON', { globalRelayEnabled: true }, 'global_relay_must_remain_off'],
    ['deploy SHA', { deployShaOk: false }, 'deploy_sha_mismatch'],
    ['signer not ready', { signerReady: false }, 'signer_not_ready'],
    ['signer locked', { signerUnlocked: false }, 'signer_not_ready'],
    ['workflow running', { workflowStillRunning: true }, 'workflow_still_running'],
    ['chain recon', { chainReconOk: false }, 'chain_recon_required'],
    ['reservation not held', { reservationHeld: false }, 'reservation_not_held'],
    ['settled', { settlementPresent: true }, 'already_settled'],
    ['released', { releasePresent: true }, 'already_released'],
    ['Gen-2 claim missing', { gen2TemporalLaunchClaimPresent: false }, 'gen2_launch_claim_missing'],
    ['Gen-3 claim not bound (mere presence insufficient)', { gen3TemporalLaunchClaimBound: false }, 'gen3_launch_claim_not_bound'],
    ['broadcast evidence', { broadcastEvidenceCount: 1 }, 'broadcast_evidence_exists'],
    ['Gen-3 not consumed', { gen3PermitStatus: 'ARMED' }, 'gen3_not_consumed'],
    ['Gen-2 not consumed', { gen2PermitStatus: 'ARMED' }, 'gen2_not_consumed'],
    ['Gen-4 not armed', { gen4PermitStatus: 'CONSUMED' }, 'gen4_not_armed'],
    ['two attempts only (Gen-3 shape)', { attemptCount: 2, failedPreAttemptCount: 2 }, 'prior_attempt_count_not_three'],
    ['four attempts', { attemptCount: 4, failedPreAttemptCount: 4 }, 'prior_attempt_count_not_three'],
    ['expected Gen-3 run id missing', { expectedGen3RunId: '' }, 'expected_gen3_run_id_missing'],
  ] as const)('refuses: %s', (_name, patch, reason) => {
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({ ...baseEligibility, ...patch }).reason,
    ).toBe(reason);
  });

  it('signerGate required (default) refuses a LOCKED / not-ready signer; deferred skips only that check', () => {
    const locked = { ...baseEligibility, signerUnlocked: false };
    const notReady = { ...baseEligibility, signerReady: false };
    expect(evaluatePhase21Gen4TemporalLaunchEligibility(locked).reason).toBe('signer_not_ready');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({ ...locked, signerGate: 'required' }).reason,
    ).toBe('signer_not_ready');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({ ...locked, signerGate: 'deferred' }),
    ).toEqual({ eligible: true, reason: null });
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({ ...notReady, signerGate: 'deferred' }),
    ).toEqual({ eligible: true, reason: null });
    // Deferred never weakens other gates.
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...locked,
        signerGate: 'deferred',
        chainReconOk: false,
      }).reason,
    ).toBe('chain_recon_required');
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...locked,
        signerGate: 'deferred',
        globalRelayEnabled: true,
      }).reason,
    ).toBe('global_relay_must_remain_off');
  });
});

describe('phase21 Gen-4 prior workflow one-shot identity (binds to Gen-3 run)', () => {
  it('accepts the Gen-3 run identity; refuses Gen-1/Gen-2 run ids (earlier generations)', () => {
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: GEN3_RUN_ID,
        observation: { found: true, runId: GEN3_RUN_ID, status: 'COMPLETED' },
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: 'COMPLETED',
      observedRunId: GEN3_RUN_ID,
      identityMode: 'live_gen3_run',
    });
    for (const stale of [GEN1_RUN_ID, GEN2_RUN_ID]) {
      expect(
        evaluatePhase21Gen4PriorWorkflowIdentity({
          expectedGen3RunId: GEN3_RUN_ID,
          observation: { found: true, runId: stale, status: 'COMPLETED' },
        }).reason,
      ).toBe('gen4_already_launched_or_run_mismatch');
    }
  });

  it('refuses already-launched Gen-4 including after COMPLETED / RUNNING', () => {
    for (const status of ['COMPLETED', 'RUNNING', 'FAILED']) {
      expect(
        evaluatePhase21Gen4PriorWorkflowIdentity({
          expectedGen3RunId: GEN3_RUN_ID,
          observation: { found: true, runId: GEN4_RUN_ID, status },
        }).reason,
      ).toBe('gen4_already_launched_or_run_mismatch');
    }
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        observedPriorRunId: GEN4_RUN_ID,
      }).reason,
    ).toBe('gen4_already_launched_or_run_mismatch');
  });

  it('refuses missing/ambiguous expected or observed run identity', () => {
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: '',
        observation: { found: true, runId: GEN3_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('expected_gen3_run_id_missing');
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: undefined,
        observation: { found: true, runId: GEN3_RUN_ID, status: 'COMPLETED' },
      }).reason,
    ).toBe('expected_gen3_run_id_missing');
    for (const runId of [null, undefined, '   ']) {
      expect(
        evaluatePhase21Gen4PriorWorkflowIdentity({
          expectedGen3RunId: GEN3_RUN_ID,
          observation: { found: true, runId, status: 'COMPLETED' },
        }).reason,
      ).toBe('prior_run_id_ambiguous');
    }
  });

  it('refuses missing prior workflow without durable evidence (never assume COMPLETED)', () => {
    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: GEN3_RUN_ID,
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
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: 'COMPLETED', // must not open the gate when history is missing
      }).reason,
    ).toBe('prior_workflow_not_found');
  });

  it('accepts durable Gen-3 terminal evidence when Temporal history is absent', () => {
    expect(evaluatePhase21Gen4DurableGen3TerminalEvidence(DURABLE_OK)).toEqual({ ok: true, reason: null });
    const refuse = (patch: Partial<Phase21Gen4DurableGen3TerminalEvidence>) =>
      evaluatePhase21Gen4DurableGen3TerminalEvidence({ ...DURABLE_OK, ...patch }).reason;
    expect(refuse({ gen1PermitStatus: 'ARMED' })).toBe('durable_gen1_not_consumed');
    expect(refuse({ gen1ConsumedAttemptId: null })).toBe('durable_gen1_attempt_unbound');
    expect(refuse({ gen2PermitStatus: 'ARMED' })).toBe('durable_gen2_not_consumed');
    expect(refuse({ gen2ConsumedAttemptId: null })).toBe('durable_gen2_attempt_unbound');
    expect(refuse({ gen2ConsumedAttemptId: 'attempt-1' })).toBe('durable_gen2_attempt_same_as_gen1');
    expect(refuse({ gen3PermitStatus: 'ARMED' })).toBe('durable_gen3_not_consumed');
    expect(refuse({ gen3ConsumedAttemptId: null })).toBe('durable_gen3_attempt_unbound');
    expect(refuse({ gen3ConsumedAttemptId: 'attempt-2' })).toBe('durable_gen3_attempt_not_distinct');
    expect(refuse({ attemptCount: 2, failedPreAttemptCount: 2 })).toBe('durable_attempt_shape_refused');
    expect(refuse({ attemptCount: 4, failedPreAttemptCount: 4 })).toBe('durable_attempt_shape_refused');
    expect(refuse({ failedPreAttemptCount: 2 })).toBe('durable_attempt_shape_refused');
    expect(refuse({ broadcastEvidenceCount: 1 })).toBe('durable_broadcast_evidence_exists');
    expect(refuse({ gen2TemporalLaunchClaimPresent: false })).toBe('durable_gen2_launch_claim_missing');
    expect(refuse({ gen3TemporalLaunchClaimBound: false })).toBe('durable_gen3_launch_claim_not_bound');
    expect(refuse({ gen4PermitStatus: 'CONSUMED' })).toBe('durable_gen4_not_armed');
    expect(refuse({ gen4TemporalLaunchClaimAbsent: false })).toBe('durable_gen4_launch_already_claimed');

    expect(
      evaluatePhase21Gen4PriorWorkflowIdentity({
        expectedGen3RunId: GEN3_RUN_ID,
        observation: { found: false },
        durableGen3Terminal: DURABLE_OK,
      }),
    ).toEqual({
      ok: true,
      reason: null,
      priorWorkflowStatus: PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS,
      observedRunId: null,
      identityMode: 'durable_gen3_terminal',
    });
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: '',
        durableGen3Terminal: DURABLE_OK,
      }),
    ).toEqual({ eligible: true, reason: null });
    // Durable evidence still needs the Owner-attested expected runId.
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        expectedGen3RunId: '',
        priorWorkflowFound: false,
        observedPriorRunId: null,
        priorWorkflowStatus: '',
        durableGen3Terminal: DURABLE_OK,
      }).reason,
    ).toBe('expected_gen3_run_id_missing');
    // Durable evidence is ignored when live history exists (live runId wins).
    expect(
      evaluatePhase21Gen4TemporalLaunchEligibility({
        ...baseEligibility,
        observedPriorRunId: GEN4_RUN_ID,
        durableGen3Terminal: DURABLE_OK,
      }).reason,
    ).toBe('gen4_already_launched_or_run_mismatch');
  });
});

describe('planPhase21Gen4TemporalLaunch (read-only, mocked DB)', () => {
  const planInput = (patch?: Record<string, unknown>) => ({
    withdrawalId: WID,
    chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests(),
    expectedDeploySha: 'd427269',
    liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
    globalRelayEnabled: false,
    signerReady: true,
    signerUnlocked: true,
    expectedGen3RunId: GEN3_RUN_ID,
    priorWorkflowFound: true,
    observedPriorRunId: GEN3_RUN_ID as string | null,
    priorWorkflowStatus: 'COMPLETED',
    workflowStillRunning: false,
    taskQueue: 'alex-rewards-worker',
    deploymentEnvironment: 'PRODUCTION' as const,
    ...patch,
  });
  const failedIds = (r: Phase21Gen4TemporalLaunchPlanResult) =>
    r.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
  const plan = (world: Gen4MockWorld, patch?: Record<string, unknown>) =>
    planPhase21Gen4TemporalLaunch(mockGen4Client(world) as never, planInput(patch));

  it('is ready in live-run identity mode and never mutates', async () => {
    const world = createGen4World();
    const r = await plan(world);
    expect(failedIds(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.readyForExecute).toBe(true);
    expect(r.priorWorkflowIdentityMode).toBe('live_gen3_run');
    expect(r.gen3TemporalLaunchClaimBound).toBe(true);
    expect(r.gen4PermitId).toBe(GEN4_PERMIT_ID);
    expect(r.attemptCount).toBe(3);
    expect(r.startOptions?.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE');
    expect(r.relayEnabled).toBe(false);
    expect(world.log[0]).toBe('BEGIN READ ONLY');
    expect(world.log.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });

  it('is ready in durable Gen-3 terminal mode when Temporal history is absent', async () => {
    const r = await plan(createGen4World(), {
      priorWorkflowFound: false,
      observedPriorRunId: null,
      priorWorkflowStatus: '',
    });
    expect(failedIds(r)).toEqual([]);
    expect(r.readyForExecute).toBe(true);
    expect(r.priorWorkflowIdentityMode).toBe('durable_gen3_terminal');
  });

  it('refuses when the Gen-3 run id is not the live run (Gen-2 run, Gen-4 already launched)', async () => {
    for (const observed of [GEN2_RUN_ID, GEN4_RUN_ID]) {
      const r = await plan(createGen4World(), { observedPriorRunId: observed });
      expect(r.readyForExecute).toBe(false);
      expect(failedIds(r)).toContain('prior_workflow_identity');
      expect(r.startOptions).toBeNull();
    }
  });

  const worldRefusals: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    ['Gen-4 not armed', (w) => void (w.permits = w.permits.filter((p) => p.generation !== 4)), 'gen4_armed'],
    [
      'Gen-4 CANCELLED',
      (w) => void (w.permits.find((p) => p.generation === 4)!.status = 'CANCELLED'),
      'gen4_armed',
    ],
    [
      'Gen-4 permit id reuses Gen-3 permit id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = GEN3_PERMIT_ID),
      'gen4_not_prior_generation_reuse',
    ],
    [
      'Gen-4 permit id reuses Gen-1 permit id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = GEN1_PERMIT_ID),
      'gen4_not_prior_generation_reuse',
    ],
    [
      'Gen-3 claim forged (wrong permit in payload)',
      (w) => {
        w.outbox.get(gen3ClaimKey())!.payload = gen3ClaimPayload({
          gen3PermitId: '99999999-9999-4999-8999-999999999999',
        });
      },
      'gen3_temporal_launch_claim_bound',
    ],
    ['Gen-3 claim missing', (w) => void w.outbox.delete(gen3ClaimKey()), 'gen3_temporal_launch_claim_bound'],
    [
      'Gen-3 claim PENDING',
      (w) => void (w.outbox.get(gen3ClaimKey())!.status = 'PENDING'),
      'gen3_temporal_launch_claim_bound',
    ],
    [
      'Gen-4 claim already present (one-shot)',
      (w) =>
        void w.outbox.set(`withdrawal.phase21_gen4_temporal_launch:${WID}:${GEN4_PERMIT_ID}`, {
          id: 'claim-gen4',
          eventType: PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
          status: 'DISPATCHED',
          aggregateType: 'withdrawal',
          aggregateId: WID,
          payload: {},
        }),
      'gen4_temporal_launch_claim_absent',
    ],
    ['pause off', (w) => void (w.paused = false), 'payout_dispatch_pause_preserved'],
    ['attempt #3 has evidence', (w) => void (w.attempts[2]!.hasEvidence = true), 'attempts_1_2_and_3_failed_pre_no_evidence'],
    ['attempt query id differs', (w) => void (w.attempts[1]!.queryId = 'other'), 'chain_recon_prior_query_ids_match_db'],
    ['only two attempts', (w) => void w.attempts.pop(), 'attempts_1_2_and_3_failed_pre_no_evidence'],
  ];

  it.each(worldRefusals)('refuses: %s', async (_name, mutate, checkId) => {
    const world = createGen4World();
    mutate(world);
    const r = await plan(world);
    expect(r.readyForExecute).toBe(false);
    expect(r.startOptions).toBeNull();
    expect(failedIds(r)).toContain(checkId);
  });

  it('PLAN passes safety while Signer is LOCKED (or not ready) but readyForExecute stays false', async () => {
    for (const patch of [
      { signerUnlocked: false },
      { signerReady: false },
      { signerReady: false, signerUnlocked: false },
    ]) {
      const world = createGen4World();
      const r = await plan(world, patch);
      expect(r.ok).toBe(true);
      expect(r.readyForExecute).toBe(false);
      expect(r.startOptions).not.toBeNull();
      const byId = new Map(r.checks.map((c) => [c.id, c.status]));
      expect(byId.get('signer_state_observed')).toBe('PASS');
      expect(byId.get('signer_unlocked_for_execute')).toBe('FAIL');
      expect(failedIds(r)).toEqual(['signer_unlocked_for_execute']);
      expect(world.log.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
    }
    const unlocked = await plan(createGen4World());
    expect(unlocked.readyForExecute).toBe(true);
    expect(
      new Map(unlocked.checks.map((c) => [c.id, c.status])).get('signer_unlocked_for_execute'),
    ).toBe('PASS');
  });

  it('PLAN with a LOCKED signer is still not ok when any other safety gate fails', async () => {
    const r = await plan(createGen4World(), { signerUnlocked: false, globalRelayEnabled: true });
    expect(r.ok).toBe(false);
    expect(r.readyForExecute).toBe(false);
    expect(r.startOptions).toBeNull();
  });

  const swappedBindings: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    [
      'Gen-1 bound to attempt 2 and Gen-2 to attempt 1',
      (w) => {
        w.permits.find((p) => p.generation === 1)!.consumedAttemptId = 'attempt-2';
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-1';
      },
      'gen1_bound_to_attempt_1',
    ],
    [
      'Gen-2 bound to attempt 3 and Gen-3 to attempt 2',
      (w) => {
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-3';
        w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-2';
      },
      'gen2_bound_to_attempt_2',
    ],
    [
      'Gen-3 bound to a non-existent attempt id',
      (w) => void (w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-9'),
      'gen3_bound_to_attempt_3',
    ],
  ];
  it.each(swappedBindings)('PLAN refuses exact-binding violation: %s', async (_n, mutate, checkId) => {
    const world = createGen4World();
    mutate(world);
    const r = await plan(world);
    expect(r.readyForExecute).toBe(false);
    expect(r.ok).toBe(false);
    expect(failedIds(r)).toContain(checkId);
  });

  it('refuses relay ON, SHA mismatch, signer not ready/unlocked, running workflow, missing expected run id, stale recon', async () => {
    const world = () => createGen4World();
    expect(failedIds(await plan(world(), { globalRelayEnabled: true }))).toContain('global_relay_off');
    expect(failedIds(await plan(world(), { liveDeploySha: 'ffffffff' }))).toContain('live_deploy_sha');
    expect(failedIds(await plan(world(), { signerReady: false }))).toContain('signer_unlocked_for_execute');
    expect(failedIds(await plan(world(), { signerUnlocked: false }))).toContain('signer_unlocked_for_execute');
    expect(failedIds(await plan(world(), { workflowStillRunning: true }))).toContain('workflow_not_running');
    expect(failedIds(await plan(world(), { expectedGen3RunId: '' }))).toContain('prior_workflow_identity');
    const stale = await plan(world(), {
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
        performedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      }),
    });
    expect(failedIds(stale)).toContain('independent_chain_reconciliation');
    const unbound = await plan(world(), {
      chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
        priorQueryIds: ['900000000001', '900000000002', '1'],
      }),
    });
    expect(failedIds(unbound)).toContain('chain_recon_prior_query_ids_match_db');
    expect(unbound.readyForExecute).toBe(false);
  });
});

describe('phase21 Gen-4 Temporal launch EXECUTE (mocked DB)', () => {
  function startMock() {
    return vi.fn(async (_workflowType: string, opts: Record<string, unknown>) => {
      void opts;
      return { firstExecutionRunId: 'run-gen4' };
    });
  }
  const fresh = () => mintPhase21Gen4IndependentChainReconciliationForTests();
  const exec = (
    world: Gen4MockWorld,
    start: ReturnType<typeof startMock>,
    patch?: Partial<Parameters<typeof executePhase21Gen4TemporalLaunch>[0]>,
  ) =>
    executePhase21Gen4TemporalLaunch({
      confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
      plan: readyPlan(),
      temporal: { workflow: { start } },
      claimClient: mockGen4Client(world) as never,
      expectedGen3RunId: GEN3_RUN_ID,
      signerReady: true,
      signerUnlocked: true,
      chainReconciliation: fresh(),
      deploymentEnvironment: 'PRODUCTION',
      ...patch,
    });
  const claimKey = buildPhase21Gen4TemporalLaunchClaimDedupeKey({
    withdrawalId: WID,
    gen4PermitId: GEN4_PERMIT_ID,
  });

  it('requires exact Owner ACK, durable DISPATCHED claim, ready PLAN; starts once; repeat refused', async () => {
    const world = createGen4World();
    const claimClient = mockGen4Client(world);
    const start = startMock();
    const run = (phrase: string) =>
      executePhase21Gen4TemporalLaunch({
        confirmationPhrase: phrase,
        plan: readyPlan(),
        temporal: { workflow: { start } },
        claimClient: claimClient as never,
        expectedGen3RunId: GEN3_RUN_ID,
        signerReady: true,
        signerUnlocked: true,
        chainReconciliation: fresh(),
        deploymentEnvironment: 'PRODUCTION',
      });

    expect(await run(PHASE21_GEN3_TEMPORAL_LAUNCH_ACK)).toMatchObject({
      started: false,
      refuseCode: 'OWNER_ACK_REQUIRED',
    });
    expect(start).not.toHaveBeenCalled();
    expect(claimClient.query).not.toHaveBeenCalled();

    const ok = await run(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK);
    expect(ok).toMatchObject({
      ok: true,
      started: true,
      runId: 'run-gen4',
      relayEnabled: false,
      signed: false,
      broadcastPerformed: false,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![1]).toMatchObject({
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
      args: [{ withdrawalId: WID, realChainEnabled: true }],
    });

    // Durable claim row: DISPATCHED, Gen-4 event type, exact payload bindings.
    const claim = world.outbox.get(claimKey);
    expect(claim).toBeDefined();
    expect(claim!.status).toBe('DISPATCHED');
    expect(claim!.eventType).toBe('phase21.gen4_temporal_launch_claim');
    expect(claim!.payload).toMatchObject({
      withdrawalId: WID,
      gen4PermitId: GEN4_PERMIT_ID,
      expectedGen3RunId: GEN3_RUN_ID,
      identityMode: 'live_gen3_run',
      workflowId: `withdrawal/${WID}`,
      authorizationGeneration: 4,
      broadcastPerformed: false,
      signed: false,
    });
    // Gen-3 claim preserved untouched.
    expect(world.outbox.get(gen3ClaimKey())!.status).toBe('DISPATCHED');

    // Revalidation: withdrawal + permits + attempt rows all FOR UPDATE inside the txn,
    // shape read after the attempt lock, then the claim insert, then COMMIT before Temporal.
    const sqls = world.log;
    const begin = sqls.indexOf('BEGIN');
    const wdLock = sqls.findIndex((s) => s.includes('FROM withdrawals') && s.includes('FOR UPDATE'));
    const permitLock = sqls.findIndex(
      (s) => s.includes('FROM phase21_manual_dispatch_permits') && s.includes('FOR UPDATE'),
    );
    const attemptLock = sqls.findIndex(
      (s) => s.includes('FROM withdrawal_attempts') && s.includes('FOR UPDATE'),
    );
    const shape = sqls.findIndex((s) => s.includes('AS attempt3_failed_pre'));
    const insert = sqls.findIndex((s) => s.startsWith('INSERT INTO outbox_events'));
    const commit = sqls.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(wdLock);
    expect(wdLock).toBeLessThan(permitLock);
    expect(permitLock).toBeLessThan(attemptLock);
    expect(attemptLock).toBeLessThan(shape);
    expect(shape).toBeLessThan(insert);
    expect(insert).toBeLessThan(commit);
    // The Gen-3 claim binding is re-verified inside the same transaction.
    expect(
      sqls.slice(begin, insert).some((s) => s.includes('FROM outbox_events') && s.includes('payload')),
    ).toBe(true);

    // Repeated Owner request on the same DB: unique dedupe_key refuses; no second start.
    const again = await run(PHASE21_GEN4_TEMPORAL_LAUNCH_ACK);
    expect(again).toMatchObject({ started: false, refuseCode: 'GEN4_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('records identityMode durable_gen3_terminal in the claim payload when history is absent', async () => {
    const world = createGen4World();
    const start = startMock();
    const r = await exec(world, start, {
      plan: readyPlan({ priorWorkflowIdentityMode: 'durable_gen3_terminal' }),
    });
    expect(r.started).toBe(true);
    expect(world.outbox.get(claimKey)!.payload).toMatchObject({
      identityMode: 'durable_gen3_terminal',
      expectedGen3RunId: GEN3_RUN_ID,
    });
  });

  it('refuses PLAN not ready / relay ON / missing Gen-4 permit / permit reuse / claims missing before any DB access', async () => {
    const world = createGen4World();
    const start = startMock();
    const client = mockGen4Client(world);
    const run = (plan: Phase21Gen4TemporalLaunchPlanResult) =>
      exec(world, start, { plan, claimClient: client as never });

    expect(await run(readyPlan({ ok: false, readyForExecute: false }))).toMatchObject({
      refuseCode: 'PLAN_NOT_READY',
    });
    expect(await run(readyPlan({ startOptions: null }))).toMatchObject({ refuseCode: 'PLAN_NOT_READY' });
    expect(await run(readyPlan({ globalRelayEnabled: true }))).toMatchObject({
      refuseCode: 'GLOBAL_RELAY_MUST_REMAIN_OFF',
    });
    expect(await run(readyPlan({ gen4PermitId: null }))).toMatchObject({
      refuseCode: 'GEN4_PERMIT_ID_REQUIRED',
    });
    expect(await run(readyPlan({ gen4PermitId: GEN3_PERMIT_ID }))).toMatchObject({
      refuseCode: 'GEN4_PRIOR_PERMIT_REUSE_REFUSED',
    });
    expect(await run(readyPlan({ gen4PermitId: GEN2_PERMIT_ID }))).toMatchObject({
      refuseCode: 'GEN4_PRIOR_PERMIT_REUSE_REFUSED',
    });
    expect(await run(readyPlan({ gen2TemporalLaunchClaimPresent: false }))).toMatchObject({
      refuseCode: 'GEN2_LAUNCH_CLAIM_MISSING',
    });
    expect(await run(readyPlan({ gen3TemporalLaunchClaimBound: false }))).toMatchObject({
      refuseCode: 'GEN3_LAUNCH_CLAIM_NOT_BOUND',
    });
    expect(start).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses EXECUTE without signer ready+unlocked (after ACK, before any DB access / start)', async () => {
    for (const patch of [
      { signerReady: false },
      { signerUnlocked: false },
      { signerReady: false, signerUnlocked: false },
    ]) {
      const world = createGen4World();
      const start = startMock();
      const client = mockGen4Client(world);
      const r = await exec(world, start, { ...patch, claimClient: client as never });
      expect(r).toMatchObject({ ok: false, started: false, refuseCode: 'SIGNER_NOT_READY_FOR_EXECUTE' });
      expect(start).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
    }
  });

  it('EXECUTE still refuses a locked-signer PLAN (readyForExecute=false) with PLAN_NOT_READY even if signer now unlocked', async () => {
    const start = startMock();
    const lockedPlan = await planPhase21Gen4TemporalLaunch(
      mockGen4Client(createGen4World()) as never,
      {
        withdrawalId: WID,
        chainReconciliation: fresh(),
        expectedDeploySha: 'd427269',
        liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
        globalRelayEnabled: false,
        signerReady: true,
        signerUnlocked: false,
        expectedGen3RunId: GEN3_RUN_ID,
        priorWorkflowFound: true,
        observedPriorRunId: GEN3_RUN_ID,
        priorWorkflowStatus: 'COMPLETED',
        workflowStillRunning: false,
        taskQueue: 'alex-rewards-worker',
        deploymentEnvironment: 'PRODUCTION',
      },
    );
    expect(lockedPlan.ok).toBe(true);
    expect(lockedPlan.readyForExecute).toBe(false);
    const r = await exec(createGen4World(), start, { plan: lockedPlan });
    expect(r).toMatchObject({ started: false, refuseCode: 'PLAN_NOT_READY' });
    expect(start).not.toHaveBeenCalled();
  });

  const claimRefusals: ReadonlyArray<readonly [string, (w: Gen4MockWorld) => void, string]> = [
    [
      'Gen-1 bound to attempt 2 and Gen-2 bound to attempt 1 (swapped)',
      (w) => {
        w.permits.find((p) => p.generation === 1)!.consumedAttemptId = 'attempt-2';
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-1';
      },
      'CLAIM_GEN1_NOT_BOUND_TO_ATTEMPT_1',
    ],
    [
      'Gen-2 bound to a different attempt than #2 (Gen-1 exact, Gen-3 exact)',
      (w) => {
        w.attempts.push({
          id: 'attempt-4',
          attemptNumber: 4,
          state: 'FAILED_PRE_BROADCAST',
          hasEvidence: false,
          queryId: '900000000004',
        });
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-4';
      },
      'CLAIM_GEN2_NOT_BOUND_TO_ATTEMPT_2',
    ],
    [
      'Gen-2 bound to attempt 3 and Gen-3 bound to attempt 2 (Gen-3 claim binding refuses first)',
      (w) => {
        w.permits.find((p) => p.generation === 2)!.consumedAttemptId = 'attempt-3';
        w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-2';
      },
      'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_ATTEMPT_NOT_ATTEMPT3',
    ],
    ['pause flag off', (w) => void (w.paused = false), 'CLAIM_PAYOUT_PAUSE_NOT_ON'],
    ['withdrawal settled', (w) => void (w.settlement = 's1'), 'CLAIM_ALREADY_SETTLED'],
    ['withdrawal released', (w) => void (w.release = 'r1'), 'CLAIM_ALREADY_RELEASED'],
    ['reservation missing', (w) => void (w.reservation = null), 'CLAIM_RESERVATION_NOT_HELD'],
    ['withdrawal state refused', (w) => void (w.state = 'SETTLED'), 'CLAIM_WITHDRAWAL_STATE_REFUSED'],
    [
      'Gen-1 not consumed',
      (w) => void (w.permits.find((p) => p.generation === 1)!.status = 'ARMED'),
      'CLAIM_GEN1_NOT_CONSUMED',
    ],
    [
      'Gen-2 not consumed',
      (w) => void (w.permits.find((p) => p.generation === 2)!.status = 'ARMED'),
      'CLAIM_GEN2_NOT_CONSUMED',
    ],
    [
      'Gen-3 not consumed',
      (w) => void (w.permits.find((p) => p.generation === 3)!.status = 'ARMED'),
      'CLAIM_GEN3_NOT_CONSUMED',
    ],
    [
      'Gen-3 attempt equals Gen-2 attempt',
      (w) => void (w.permits.find((p) => p.generation === 3)!.consumedAttemptId = 'attempt-2'),
      'CLAIM_GEN3_ATTEMPT_NOT_DISTINCT',
    ],
    [
      'Gen-4 not armed',
      (w) => void (w.permits = w.permits.filter((p) => p.generation !== 4)),
      'CLAIM_GEN4_NOT_ARMED',
    ],
    [
      'Gen-4 permit differs from the planned permit id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = '77777777-7777-4777-8777-777777777777'),
      'CLAIM_GEN4_NOT_ARMED',
    ],
    [
      'Gen-4 id reuses Gen-3 id',
      (w) => void (w.permits.find((p) => p.generation === 4)!.id = GEN3_PERMIT_ID),
      'CLAIM_GEN4_NOT_ARMED',
    ],
    [
      'Gen-2 launch claim missing',
      (w) => {
        for (const [k, v] of [...w.outbox]) if (v.id === 'claim-gen2') w.outbox.delete(k);
      },
      'CLAIM_GEN2_LAUNCH_CLAIM_MISSING',
    ],
    [
      'Gen-3 launch claim missing',
      (w) => void w.outbox.delete(gen3ClaimKey()),
      'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_MISSING',
    ],
    [
      'Gen-3 launch claim forged (wrong permit)',
      (w) => {
        w.outbox.get(gen3ClaimKey())!.payload = gen3ClaimPayload({
          gen3PermitId: '99999999-9999-4999-8999-999999999999',
        });
      },
      'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_PAYLOAD_WRONG_PERMIT',
    ],
    [
      'attempt #3 not FAILED_PRE (Gen-3 binding)',
      (w) => void (w.attempts[2]!.state = 'BROADCAST_UNKNOWN'),
      'CLAIM_GEN3_LAUNCH_CLAIM_ATTEMPT3_NOT_FAILED_PRE',
    ],
    [
      'evidence on attempt #2',
      (w) => void (w.attempts[1]!.hasEvidence = true),
      'CLAIM_ATTEMPT_SHAPE_REFUSED',
    ],
    [
      'only two attempts',
      (w) => void (w.attempts = w.attempts.filter((a) => a.attemptNumber !== 3)),
      'CLAIM_GEN3_LAUNCH_CLAIM_ATTEMPT3_MISSING',
    ],
    [
      'a fourth attempt already exists',
      (w) =>
        void w.attempts.push({
          id: 'attempt-4',
          attemptNumber: 4,
          state: 'FAILED_PRE_BROADCAST',
          hasEvidence: false,
          queryId: '900000000004',
        }),
      'CLAIM_ATTEMPT_SHAPE_REFUSED',
    ],
    [
      'attempt query ids differ from recon (bound under lock)',
      (w) => void (w.attempts[0]!.queryId = '424242'),
      'CLAIM_CHAIN_RECON_PRIOR_QUERY_IDS_MISMATCH_DB',
    ],
  ];

  it.each(claimRefusals)('claim-txn revalidation refuses: %s (no claim, no start, ROLLBACK)', async (_name, mutate, refuseCode) => {
    const world = createGen4World();
    mutate(world);
    const start = startMock();
    const r = await exec(world, start);
    expect(r).toMatchObject({ ok: false, started: false, refuseCode });
    expect(start).not.toHaveBeenCalled();
    expect(world.outbox.has(claimKey)).toBe(false);
    expect(world.log.some((s) => s.startsWith('INSERT INTO outbox_events'))).toBe(false);
    expect(world.log).not.toContain('COMMIT');
    expect(world.log.at(-1)).toBe('ROLLBACK');
  });

  it('claim-txn revalidation refuses stale / non-HIGH / wrong-binding recon', async () => {
    const stale = mintPhase21Gen4IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const start = startMock();
    expect(
      await exec(createGen4World(), start, { chainReconciliation: stale }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_CHAIN_RECON_CHAIN_RECON_STALE_OR_FUTURE' });
    expect(
      await exec(createGen4World(), start, {
        chainReconciliation: { ...fresh(), confidence: 'UNKNOWN' as unknown as 'HIGH' },
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_CHAIN_RECON_CONFIDENCE_NOT_HIGH' });
    expect(
      await exec(createGen4World(), start, {
        chainReconciliation: { ...fresh(), hotWalletFriendly: 'EQ_not_the_hot_wallet' },
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_CHAIN_RECON_HOT_WALLET_MISMATCH' });
    expect(
      await exec(createGen4World(), start, {
        chainReconciliation: { ...fresh(), priorQueryIds: ['1', '2'] },
      }),
    ).toMatchObject({ started: false, refuseCode: 'CLAIM_CHAIN_RECON_PRIOR_QUERY_IDS_WRONG_COUNT' });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a non-canary withdrawal id unless the disposable-test override is set', async () => {
    const start = startMock();
    const world = createGen4World();
    const r = await exec(world, start, {
      plan: readyPlan({ withdrawalId: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(r).toMatchObject({ started: false, refuseCode: 'CLAIM_WITHDRAWAL_NOT_AUTHORIZED' });
    expect(start).not.toHaveBeenCalled();
  });

  it('service restart after claim: Temporal start failure keeps the claim; retry is refused, never re-started blindly', async () => {
    const world = createGen4World();
    const claimClient = mockGen4Client(world);
    const failingStart = vi.fn(async () => {
      throw new Error('TEMPORAL_UNAVAILABLE_AFTER_CLAIM');
    });
    await expect(
      executePhase21Gen4TemporalLaunch({
        confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
        plan: readyPlan(),
        temporal: { workflow: { start: failingStart } },
        claimClient: claimClient as never,
        expectedGen3RunId: GEN3_RUN_ID,
        signerReady: true,
        signerUnlocked: true,
        chainReconciliation: fresh(),
        deploymentEnvironment: 'PRODUCTION',
      }),
    ).rejects.toThrow(/TEMPORAL_UNAVAILABLE_AFTER_CLAIM/);
    expect(failingStart).toHaveBeenCalledTimes(1);
    expect(world.log.filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(world.log.some((s) => /DELETE|UPDATE outbox_events/i.test(s))).toBe(false);
    expect(world.outbox.get(claimKey)!.status).toBe('DISPATCHED');

    const start = startMock();
    const retried = await executePhase21Gen4TemporalLaunch({
      confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
      plan: readyPlan(),
      temporal: { workflow: { start } },
      claimClient: claimClient as never,
      expectedGen3RunId: GEN3_RUN_ID,
      signerReady: true,
      signerUnlocked: true,
      chainReconciliation: fresh(),
      deploymentEnvironment: 'PRODUCTION',
    });
    expect(retried).toMatchObject({ started: false, refuseCode: 'GEN4_TEMPORAL_ALREADY_CLAIMED' });
    expect(start).not.toHaveBeenCalled();
  });
});
