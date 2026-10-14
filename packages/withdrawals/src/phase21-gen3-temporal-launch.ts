/**
 * Phase 21 Gen-3 Owner-authorized one-shot Temporal launch — PLAN + EXECUTE design.
 *
 * Separate from Gen-3 permit APPLY (which only arms + enqueues outbox).
 * Global outbox relay must remain OFF; this path starts exactly one
 * withdrawal/{id} workflow under Owner confirmation after fresh gates.
 *
 * Never signs, never broadcasts, never enables relay, never mutates permits.
 * Temporal start uses ALLOW_DUPLICATE + FAIL conflict (same as Gen-2).
 * Real-chain activity maximumAttempts=1 remains in Worker workflow definition.
 *
 * Gen-3 differences from Gen-2:
 *   - prior workflow identity binds to the verified Gen-2 run (expectedGen2RunId);
 *   - exactly two FAILED_PRE attempts (#1 Gen-1, #2 Gen-2) with zero evidence;
 *   - Gen-1 AND Gen-2 must remain CONSUMED; the durable Gen-2 launch claim must
 *     remain DISPATCHED (preserved); the Gen-3 launch claim must be absent;
 *   - a signed-but-lost Signer response for attempt #2 is tolerated only when no
 *     BOC / hash / submit / chain reference was ever persisted AND fresh HIGH
 *     dual-provider chain recon shows no payment — never a blind retry.
 */
import type { PoolClient } from 'pg';

import {
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  type Phase21CanaryPayoutCheck,
  type Phase21CanaryPayoutPlanClient,
} from './phase21-canary-payout-plan.js';
import { PHASE21_NETWORK_CODE } from './phase21-config.js';
import { PHASE21_GEN2_AUTHORIZATION_GENERATION } from './phase21-gen2-recovery-plan.js';
import {
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
  evaluatePhase21Gen2LiveDeployShaMatch,
} from './phase21-gen2-temporal-launch.js';
import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT,
  PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
  evaluatePhase21Gen3ChainReconciliationFreshness,
  evaluatePhase21Gen3ConsumedFailedPreRecovery,
  isPhase21Gen3AttemptShapeAccepted,
  isPhase21Gen3PriorWorkflowSafeToRestart,
  readPhase21Gen2TemporalLaunchClaimPresent,
  readPhase21Gen3AttemptShape,
  type Phase21Gen3IndependentChainReconciliation,
} from './phase21-gen3-recovery-plan.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration,
} from './phase21-manual-dispatch-permit.js';
import { withdrawalWorkflowId } from './outbox.js';

export const PHASE21_GEN3_TEMPORAL_LAUNCH_ACK =
  'I_AUTHORIZE_WD_000001_GEN3_TEMPORAL_ONE_SHOT' as const;

export const PHASE21_GEN3_TEMPORAL_LAUNCH_WORKFLOW_TYPE = 'withdrawalPayoutWorkflow' as const;
export const PHASE21_GEN3_TEMPORAL_LAUNCH_REUSE_POLICY = 'ALLOW_DUPLICATE' as const;
export const PHASE21_GEN3_TEMPORAL_LAUNCH_CONFLICT_POLICY = 'FAIL' as const;

/** Outbox event_type for durable Gen-3 Temporal one-shot claim (never relayed; status DISPATCHED). */
export const PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE =
  'phase21.gen3_temporal_launch_claim' as const;

export function buildPhase21Gen3TemporalLaunchClaimDedupeKey(input: {
  readonly withdrawalId: string;
  readonly gen3PermitId: string;
}): string {
  return `withdrawal.phase21_gen3_temporal_launch:${input.withdrawalId}:${input.gen3PermitId}`;
}

export interface Phase21Gen3TemporalLaunchStartOptions {
  readonly workflowType: typeof PHASE21_GEN3_TEMPORAL_LAUNCH_WORKFLOW_TYPE;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly args: readonly [{ readonly withdrawalId: string; readonly realChainEnabled: true }];
  readonly workflowIdReusePolicy: typeof PHASE21_GEN3_TEMPORAL_LAUNCH_REUSE_POLICY;
  readonly workflowIdConflictPolicy: typeof PHASE21_GEN3_TEMPORAL_LAUNCH_CONFLICT_POLICY;
}

export function buildPhase21Gen3TemporalLaunchStartOptions(input: {
  readonly withdrawalId: string;
  readonly taskQueue: string;
}): Phase21Gen3TemporalLaunchStartOptions {
  return {
    workflowType: PHASE21_GEN3_TEMPORAL_LAUNCH_WORKFLOW_TYPE,
    workflowId: withdrawalWorkflowId(input.withdrawalId),
    taskQueue: input.taskQueue,
    args: [{ withdrawalId: input.withdrawalId, realChainEnabled: true }],
    workflowIdReusePolicy: PHASE21_GEN3_TEMPORAL_LAUNCH_REUSE_POLICY,
    workflowIdConflictPolicy: PHASE21_GEN3_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  };
}

export function assertPhase21Gen3TemporalLaunchAck(phrase: string): void {
  if (phrase !== PHASE21_GEN3_TEMPORAL_LAUNCH_ACK) {
    throw new Error('PRECHECK_FAILED_OWNER_ACK');
  }
}

/** Same SHA normalisation rules as Gen-2 (>= 7 hex chars; prefix equality accepted). */
export function evaluatePhase21Gen3LiveDeployShaMatch(input: {
  readonly expectedDeploySha: string | null | undefined;
  readonly liveDeploySha: string | null | undefined;
}): { readonly ok: boolean; readonly reason: string | null } {
  return evaluatePhase21Gen2LiveDeployShaMatch(input);
}

/**
 * Read-only Gen-2 workflow run identity gate for Gen-3 one-shot Temporal launch.
 *
 * ConflictPolicy FAIL only blocks concurrent starts. After a Gen-3 run has started
 * (and even after it COMPLETED), ALLOW_DUPLICATE would otherwise permit a second
 * sequential launch. Bind launch to the previously verified Gen-2 runId:
 * if history is missing, expected identity is absent, or live runId differs —
 * refuse (fail closed; never assume COMPLETED on WorkflowNotFound alone).
 *
 * When Temporal history is absent (e.g. 24h namespace retention), a durable DB
 * terminal-evidence path may open ONLY with Owner-attested expectedGen2RunId plus
 * Gen-1 + Gen-2 CONSUMED / attempts #1 + #2 FAILED_PRE zero-evidence / Gen-2 launch
 * claim present / Gen-3 ARMED / Gen-3 launch claim absent. Missing history never
 * implies "no previous payment" — chain recon remains mandatory elsewhere.
 */
export type Phase21Gen3PriorWorkflowObservation =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly runId: string | null | undefined;
      readonly status: string;
    };

export type Phase21Gen3DurableGen2TerminalEvidence = {
  readonly gen1PermitStatus: string;
  readonly gen1ConsumedAttemptId: string | null;
  readonly gen2PermitStatus: string;
  readonly gen2ConsumedAttemptId: string | null;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly gen2TemporalLaunchClaimPresent: boolean;
  readonly gen3PermitStatus: string;
  readonly gen3TemporalLaunchClaimAbsent: boolean;
};

export type Phase21Gen3PriorWorkflowIdentityMode = 'live_gen2_run' | 'durable_gen2_terminal';

export function evaluatePhase21Gen3DurableGen2TerminalEvidence(
  evidence: Phase21Gen3DurableGen2TerminalEvidence,
): { readonly ok: boolean; readonly reason: string | null } {
  if (evidence.gen1PermitStatus !== 'CONSUMED') {
    return { ok: false, reason: 'durable_gen1_not_consumed' };
  }
  if (evidence.gen1ConsumedAttemptId === null || evidence.gen1ConsumedAttemptId.trim() === '') {
    return { ok: false, reason: 'durable_gen1_attempt_unbound' };
  }
  if (evidence.gen2PermitStatus !== 'CONSUMED') {
    return { ok: false, reason: 'durable_gen2_not_consumed' };
  }
  if (evidence.gen2ConsumedAttemptId === null || evidence.gen2ConsumedAttemptId.trim() === '') {
    return { ok: false, reason: 'durable_gen2_attempt_unbound' };
  }
  if (evidence.gen1ConsumedAttemptId === evidence.gen2ConsumedAttemptId) {
    return { ok: false, reason: 'durable_gen2_attempt_same_as_gen1' };
  }
  if (
    evidence.attemptCount !== PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT ||
    evidence.failedPreAttemptCount !== PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT
  ) {
    return { ok: false, reason: 'durable_attempt_shape_refused' };
  }
  if (evidence.broadcastEvidenceCount !== 0) {
    return { ok: false, reason: 'durable_broadcast_evidence_exists' };
  }
  if (evidence.gen2TemporalLaunchClaimPresent !== true) {
    return { ok: false, reason: 'durable_gen2_launch_claim_missing' };
  }
  if (evidence.gen3PermitStatus !== 'ARMED') {
    return { ok: false, reason: 'durable_gen3_not_armed' };
  }
  if (evidence.gen3TemporalLaunchClaimAbsent !== true) {
    return { ok: false, reason: 'durable_gen3_launch_already_claimed' };
  }
  return { ok: true, reason: null };
}

export function evaluatePhase21Gen3PriorWorkflowIdentity(input: {
  readonly expectedGen2RunId: string | null | undefined;
  readonly observation: Phase21Gen3PriorWorkflowObservation;
  /** Required when observation.found=false; ignored when live Temporal history exists. */
  readonly durableGen2Terminal?: Phase21Gen3DurableGen2TerminalEvidence | null;
}): {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly priorWorkflowStatus: string | null;
  readonly observedRunId: string | null;
  readonly identityMode: Phase21Gen3PriorWorkflowIdentityMode | null;
} {
  const expected = (input.expectedGen2RunId ?? '').trim();
  if (expected === '') {
    return {
      ok: false,
      reason: 'expected_gen2_run_id_missing',
      priorWorkflowStatus: null,
      observedRunId: null,
      identityMode: null,
    };
  }
  if (!input.observation.found) {
    const durable = input.durableGen2Terminal;
    if (durable === undefined || durable === null) {
      return {
        ok: false,
        reason: 'prior_workflow_not_found',
        priorWorkflowStatus: null,
        observedRunId: null,
        identityMode: null,
      };
    }
    const durableGate = evaluatePhase21Gen3DurableGen2TerminalEvidence(durable);
    if (!durableGate.ok) {
      return {
        ok: false,
        reason: durableGate.reason,
        priorWorkflowStatus: null,
        observedRunId: null,
        identityMode: null,
      };
    }
    // Never invent COMPLETED — history is absent; durable terminal only.
    return {
      ok: true,
      reason: null,
      priorWorkflowStatus: PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS,
      observedRunId: null,
      identityMode: 'durable_gen2_terminal',
    };
  }
  const observedRunId = (input.observation.runId ?? '').trim();
  if (observedRunId === '') {
    return {
      ok: false,
      reason: 'prior_run_id_ambiguous',
      priorWorkflowStatus: input.observation.status,
      observedRunId: null,
      identityMode: null,
    };
  }
  if (observedRunId !== expected) {
    return {
      ok: false,
      reason: 'gen3_already_launched_or_run_mismatch',
      priorWorkflowStatus: input.observation.status,
      observedRunId,
      identityMode: null,
    };
  }
  return {
    ok: true,
    reason: null,
    priorWorkflowStatus: input.observation.status,
    observedRunId,
    identityMode: 'live_gen2_run',
  };
}

/**
 * Pure eligibility for Gen-3 Temporal one-shot launch (after Gen-3 permit already ARMED).
 */
export function evaluatePhase21Gen3TemporalLaunchEligibility(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen3PermitStatus: string;
  readonly gen3AuthorizationGeneration: number;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly gen2TemporalLaunchClaimPresent: boolean;
  readonly reservationHeld: boolean;
  readonly settlementPresent: boolean;
  readonly releasePresent: boolean;
  readonly chainReconOk: boolean;
  readonly globalRelayEnabled: boolean;
  readonly deployShaOk: boolean;
  readonly signerReady: boolean;
  readonly signerUnlocked: boolean;
  readonly expectedGen2RunId: string | null | undefined;
  readonly priorWorkflowFound: boolean;
  readonly observedPriorRunId: string | null | undefined;
  readonly priorWorkflowStatus: string;
  readonly workflowStillRunning: boolean;
  readonly durableGen2Terminal?: Phase21Gen3DurableGen2TerminalEvidence | null;
}): { readonly eligible: boolean; readonly reason: string | null } {
  if (input.globalRelayEnabled === true) {
    return { eligible: false, reason: 'global_relay_must_remain_off' };
  }
  if (!input.deployShaOk) {
    return { eligible: false, reason: 'deploy_sha_mismatch' };
  }
  if (!input.signerReady || !input.signerUnlocked) {
    return { eligible: false, reason: 'signer_not_ready' };
  }
  if (input.workflowStillRunning) {
    return { eligible: false, reason: 'workflow_still_running' };
  }
  if (!input.chainReconOk) {
    return { eligible: false, reason: 'chain_recon_required' };
  }
  if (!input.reservationHeld) {
    return { eligible: false, reason: 'reservation_not_held' };
  }
  if (input.settlementPresent) {
    return { eligible: false, reason: 'already_settled' };
  }
  if (input.releasePresent) {
    return { eligible: false, reason: 'already_released' };
  }
  if (input.gen2TemporalLaunchClaimPresent !== true) {
    return { eligible: false, reason: 'gen2_launch_claim_missing' };
  }

  const identity = evaluatePhase21Gen3PriorWorkflowIdentity({
    expectedGen2RunId: input.expectedGen2RunId,
    observation: input.priorWorkflowFound
      ? {
          found: true,
          runId: input.observedPriorRunId,
          status: input.priorWorkflowStatus,
        }
      : { found: false },
    ...(input.priorWorkflowFound
      ? {}
      : {
          durableGen2Terminal: input.durableGen2Terminal ?? null,
        }),
  });
  if (!identity.ok) {
    return { eligible: false, reason: identity.reason };
  }

  const statusForConsumedGate =
    identity.identityMode === 'durable_gen2_terminal'
      ? PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS
      : input.priorWorkflowStatus;
  const base = evaluatePhase21Gen3ConsumedFailedPreRecovery({
    withdrawalState: input.withdrawalState,
    gen1PermitStatus: input.gen1PermitStatus,
    gen2PermitStatus: input.gen2PermitStatus,
    gen3PermitStatus: input.gen3PermitStatus,
    gen3AuthorizationGeneration: input.gen3AuthorizationGeneration,
    attemptCount: input.attemptCount,
    failedPreAttemptCount: input.failedPreAttemptCount,
    broadcastEvidenceCount: input.broadcastEvidenceCount,
    priorWorkflowStatus: statusForConsumedGate,
  });
  if (!base.eligible) {
    return base;
  }
  if (!isPhase21Gen3PriorWorkflowSafeToRestart(statusForConsumedGate)) {
    return { eligible: false, reason: 'prior_workflow_not_safe' };
  }
  return { eligible: true, reason: null };
}

export interface Phase21Gen3TemporalLaunchPlanResult {
  readonly ok: boolean;
  readonly mode: 'PLAN';
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly workflowId: string;
  readonly readyForExecute: boolean;
  readonly checks: readonly Phase21CanaryPayoutCheck[];
  readonly gen1PermitStatus: string | null;
  readonly gen1ConsumedAttemptId: string | null;
  readonly gen2PermitId: string | null;
  readonly gen2PermitStatus: string | null;
  readonly gen2ConsumedAttemptId: string | null;
  readonly gen2TemporalLaunchClaimPresent: boolean;
  readonly gen3PermitId: string | null;
  readonly gen3PermitStatus: string | null;
  readonly attemptCount: number;
  readonly reservationHeld: boolean;
  readonly globalRelayEnabled: false | true;
  readonly priorWorkflowIdentityMode: Phase21Gen3PriorWorkflowIdentityMode | null;
  readonly startOptions: Phase21Gen3TemporalLaunchStartOptions | null;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly mutated: false;
  readonly relayEnabled: false;
}

function check(
  id: string,
  pass: boolean,
  note: string,
  extra?: { expected?: unknown; actual?: unknown },
): Phase21CanaryPayoutCheck {
  return {
    id,
    status: pass ? 'PASS' : 'FAIL',
    note,
    ...(extra?.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra?.actual !== undefined ? { actual: extra.actual } : {}),
  };
}

/**
 * Read-only PLAN for Gen-3 Temporal launch. Does not start Temporal.
 * Caller supplies fresh chain recon, deploy SHA evidence, signer + Temporal observations.
 */
export async function planPhase21Gen3TemporalLaunch(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
    readonly expectedDeploySha: string;
    readonly liveDeploySha: string;
    readonly globalRelayEnabled: boolean;
    readonly signerReady: boolean;
    readonly signerUnlocked: boolean;
    readonly expectedGen2RunId: string;
    readonly priorWorkflowFound: boolean;
    readonly observedPriorRunId: string | null;
    readonly priorWorkflowStatus: string;
    readonly workflowStillRunning: boolean;
    readonly taskQueue: string;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen3TemporalLaunchPlanResult> {
  const checks: Phase21CanaryPayoutCheck[] = [];
  const env = input.deploymentEnvironment ?? 'LOCAL';
  const workflowId = withdrawalWorkflowId(input.withdrawalId);

  const canaryIdOk =
    input.withdrawalId === PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  checks.push(
    check('withdrawal_id_authorized', canaryIdOk, 'Gen-3 Temporal launch hard-binds to canary (or test override)', {
      expected: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      actual: input.withdrawalId,
    }),
  );

  checks.push(
    check(
      'global_relay_off',
      input.globalRelayEnabled === false,
      'WORKER_OUTBOX_RELAY_ENABLED must remain false',
      { expected: false, actual: input.globalRelayEnabled },
    ),
  );

  const sha = evaluatePhase21Gen3LiveDeployShaMatch({
    expectedDeploySha: input.expectedDeploySha,
    liveDeploySha: input.liveDeploySha,
  });
  checks.push(
    check('live_deploy_sha', sha.ok, sha.ok ? 'live Worker deploy SHA matches Owner expected' : `sha refused: ${sha.reason}`, {
      expected: input.expectedDeploySha,
      actual: input.liveDeploySha,
    }),
  );

  const recon = evaluatePhase21Gen3ChainReconciliationFreshness(input.chainReconciliation);
  checks.push(
    check(
      'independent_chain_reconciliation',
      recon.ok,
      recon.ok ? 'fresh dual-provider HIGH no-payment recon' : `chain recon refused: ${recon.reason}`,
    ),
  );

  checks.push(
    check('signer_ready_unlocked', input.signerReady && input.signerUnlocked, 'Signer must be signingReady + UNLOCKED', {
      actual: { signingReady: input.signerReady, unlocked: input.signerUnlocked },
    }),
  );

  checks.push(
    check(
      'workflow_not_running',
      input.workflowStillRunning === false,
      'refuse Temporal start while withdrawal/{id} is RUNNING',
      { actual: input.workflowStillRunning },
    ),
  );

  let publicId: string = PHASE21_CANARY_PAYOUT_PUBLIC_ID;
  let gen1PermitStatus: string | null = null;
  let gen1ConsumedAttemptId: string | null = null;
  let gen2PermitId: string | null = null;
  let gen2PermitStatus: string | null = null;
  let gen2ConsumedAttemptId: string | null = null;
  let gen2TemporalLaunchClaimPresent = false;
  let gen3PermitId: string | null = null;
  let gen3PermitStatus: string | null = null;
  let attemptCount = 0;
  let reservationHeld = false;
  let withdrawalState = '';
  let failedPreAttemptCount = 0;
  let broadcastEvidenceCount = 0;
  let settlementPresent = false;
  let releasePresent = false;

  await client.query('BEGIN READ ONLY');
  try {
    const paused = await isPayoutDispatchPaused(client, env);
    checks.push(
      check('payout_dispatch_pause_preserved', paused === true, 'PAYOUT_DISPATCH_PAUSE must remain ON', {
        expected: true,
        actual: paused,
      }),
    );

    const w = await client.query<{
      public_id: string;
      state: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
      network_code: string;
      recipient_friendly: string;
      recipient_raw: string;
    }>(
      `SELECT w.public_id, w.state::text AS state,
              w.requested_amount_atomic::text AS requested_amount_atomic,
              w.fee_amount_atomic::text AS fee_amount_atomic,
              w.net_amount_atomic::text AS net_amount_atomic,
              w.reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
              w.release_ledger_tx_id::text AS release_ledger_tx_id,
              w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              n.code AS network_code,
              uw.friendly_address AS recipient_friendly,
              uw.raw_address AS recipient_raw
       FROM withdrawals w
       JOIN networks n ON n.id = w.network_id
       JOIN user_wallets uw ON uw.id = w.wallet_id
       WHERE w.id = $1::uuid`,
      [input.withdrawalId],
    );
    const row = w.rows[0];
    checks.push(check('withdrawal_present', row !== undefined, 'withdrawal row must exist'));

    if (row !== undefined) {
      publicId = row.public_id;
      withdrawalState = row.state;
      reservationHeld = row.reservation_ledger_tx_id !== null;
      settlementPresent = row.settlement_ledger_tx_id !== null;
      releasePresent = row.release_ledger_tx_id !== null;

      const bindOk =
        input.allowNonCanaryWithdrawalIdForTests === true ||
        (row.public_id === PHASE21_CANARY_PAYOUT_PUBLIC_ID &&
          row.requested_amount_atomic ===
            PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10) &&
          row.fee_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10) &&
          row.net_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10) &&
          row.recipient_friendly === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY &&
          row.recipient_raw === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW &&
          row.network_code === PHASE21_NETWORK_CODE);
      checks.push(check('frozen_bindings', bindOk, 'amounts/recipient/network match canary bindings'));
      checks.push(
        check(
          'withdrawal_state',
          row.state === 'FAILED_PRE_BROADCAST' || row.state === 'QUEUED',
          'state must be FAILED_PRE_BROADCAST or QUEUED',
          { actual: row.state },
        ),
      );
      checks.push(check('reservation_held', reservationHeld, 'reuse original reservation'));
      checks.push(check('no_settlement', !settlementPresent, 'must not be settled'));
      checks.push(check('no_release', !releasePresent, 'must not be released'));

      const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        1,
      );
      gen1PermitStatus = gen1?.status ?? null;
      gen1ConsumedAttemptId = gen1?.consumedAttemptId ?? null;
      checks.push(
        check('gen1_consumed_preserved', gen1?.status === 'CONSUMED', 'Gen-1 CONSUMED must remain', {
          actual: gen1PermitStatus,
        }),
      );
      checks.push(
        check('gen1_bound_attempt', gen1?.consumedAttemptId != null, 'Gen-1 must bind attempt #1', {
          actual: gen1ConsumedAttemptId,
        }),
      );

      const gen2 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN2_AUTHORIZATION_GENERATION,
      );
      gen2PermitId = gen2?.id ?? null;
      gen2PermitStatus = gen2?.status ?? null;
      gen2ConsumedAttemptId = gen2?.consumedAttemptId ?? null;
      checks.push(
        check('gen2_consumed_preserved', gen2?.status === 'CONSUMED', 'Gen-2 CONSUMED must remain (never reuse Gen-2)', {
          actual: gen2PermitStatus,
        }),
      );
      checks.push(
        check('gen2_bound_attempt', gen2?.consumedAttemptId != null, 'Gen-2 must bind attempt #2', {
          actual: gen2ConsumedAttemptId,
        }),
      );
      checks.push(
        check(
          'gen2_bound_attempt_differs_from_gen1',
          gen1?.consumedAttemptId != null &&
            gen2?.consumedAttemptId != null &&
            gen1.consumedAttemptId !== gen2.consumedAttemptId,
          'Gen-1 and Gen-2 must bind distinct attempts',
        ),
      );

      if (gen2PermitId !== null) {
        gen2TemporalLaunchClaimPresent = await readPhase21Gen2TemporalLaunchClaimPresent(client, {
          withdrawalId: input.withdrawalId,
          gen2PermitId,
        });
      }
      checks.push(
        check(
          'gen2_temporal_launch_claim_preserved',
          gen2TemporalLaunchClaimPresent,
          'durable Gen-2 Temporal launch claim must remain DISPATCHED (preserve; never clear)',
          {
            expected:
              gen2PermitId !== null
                ? buildPhase21Gen2TemporalLaunchClaimDedupeKey({
                    withdrawalId: input.withdrawalId,
                    gen2PermitId,
                  })
                : null,
            actual: gen2TemporalLaunchClaimPresent ? 'present' : 'absent',
          },
        ),
      );

      const gen3 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN3_AUTHORIZATION_GENERATION,
      );
      gen3PermitId = gen3?.id ?? null;
      gen3PermitStatus = gen3?.status ?? null;
      checks.push(
        check('gen3_armed', gen3?.status === 'ARMED', 'Gen-3 permit must be ARMED before Temporal launch', {
          actual: gen3PermitStatus,
        }),
      );
      checks.push(
        check(
          'gen3_not_prior_generation_reuse',
          gen3 !== null &&
            gen1 !== null &&
            gen2 !== null &&
            gen3.id !== gen1.id &&
            gen3.id !== gen2.id,
          'Gen-3 permit id must differ from Gen-1 and Gen-2 (never reuse prior permits)',
        ),
      );

      const shape = await readPhase21Gen3AttemptShape(client, input.withdrawalId);
      attemptCount = shape.attemptCount;
      failedPreAttemptCount = shape.failedPreAttemptCount;
      broadcastEvidenceCount = shape.evidenceCount;
      checks.push(
        check(
          'attempts_1_and_2_failed_pre_no_evidence',
          isPhase21Gen3AttemptShapeAccepted(shape),
          'exactly attempts #1 and #2, both FAILED_PRE with zero broadcast/signature evidence; never re-sign a prior attempt',
          {
            expected: { attemptCount: 2, failedPre: 2, evidence: 0 },
            actual: {
              attemptCount: shape.attemptCount,
              failedPreAttemptCount: shape.failedPreAttemptCount,
              broadcastEvidenceCount: shape.evidenceCount,
              attempt1FailedPre: shape.attempt1FailedPre,
              attempt2FailedPre: shape.attempt2FailedPre,
            },
          },
        ),
      );

      if (gen3PermitId !== null) {
        const claimKey = buildPhase21Gen3TemporalLaunchClaimDedupeKey({
          withdrawalId: input.withdrawalId,
          gen3PermitId,
        });
        const claim = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox_events WHERE dedupe_key = $1`,
          [claimKey],
        );
        const claimAbsent = (claim.rows[0]?.n ?? 0) === 0;
        checks.push(
          check(
            'gen3_temporal_launch_claim_absent',
            claimAbsent,
            'durable Gen-3 Temporal launch claim must be absent (one-shot)',
            { expected: claimKey, actual: claimAbsent ? 'absent' : 'present' },
          ),
        );
      }
    }

    await client.query('ROLLBACK');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw error;
  }

  const claimAbsentCheck = checks.find((c) => c.id === 'gen3_temporal_launch_claim_absent');
  const gen3TemporalLaunchClaimAbsent = claimAbsentCheck?.status !== 'FAIL';

  const durableGen2Terminal: Phase21Gen3DurableGen2TerminalEvidence | null = input
    .priorWorkflowFound
    ? null
    : {
        gen1PermitStatus: gen1PermitStatus ?? '',
        gen1ConsumedAttemptId,
        gen2PermitStatus: gen2PermitStatus ?? '',
        gen2ConsumedAttemptId,
        attemptCount,
        failedPreAttemptCount,
        broadcastEvidenceCount,
        gen2TemporalLaunchClaimPresent,
        gen3PermitStatus: gen3PermitStatus ?? '',
        gen3TemporalLaunchClaimAbsent,
      };

  const identity = evaluatePhase21Gen3PriorWorkflowIdentity({
    expectedGen2RunId: input.expectedGen2RunId,
    observation: input.priorWorkflowFound
      ? {
          found: true,
          runId: input.observedPriorRunId,
          status: input.priorWorkflowStatus,
        }
      : { found: false },
    durableGen2Terminal,
  });
  checks.push(
    check(
      'prior_workflow_identity',
      identity.ok,
      identity.ok
        ? identity.identityMode === 'durable_gen2_terminal'
          ? 'Temporal history absent; durable Gen-2 terminal evidence + Owner-attested Gen-2 runId accepted (never assumes no payment)'
          : 'live Temporal runId matches verified Gen-2 one-shot launch evidence'
        : `prior identity refused: ${identity.reason}`,
      {
        expected: input.expectedGen2RunId,
        actual: {
          found: input.priorWorkflowFound,
          runId: input.observedPriorRunId,
          status: input.priorWorkflowStatus,
          identityMode: identity.identityMode,
        },
      },
    ),
  );

  const statusForSafe =
    identity.identityMode === 'durable_gen2_terminal'
      ? PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS
      : input.priorWorkflowStatus;
  checks.push(
    check(
      'prior_workflow_safe',
      identity.ok && isPhase21Gen3PriorWorkflowSafeToRestart(statusForSafe),
      'prior Temporal status must be closed/safe for ALLOW_DUPLICATE (or durable Gen-2 terminal after retention)',
      { actual: statusForSafe },
    ),
  );

  const eligibility = evaluatePhase21Gen3TemporalLaunchEligibility({
    withdrawalState,
    gen1PermitStatus: gen1PermitStatus ?? '',
    gen2PermitStatus: gen2PermitStatus ?? '',
    gen3PermitStatus: gen3PermitStatus ?? '',
    gen3AuthorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
    attemptCount,
    failedPreAttemptCount,
    broadcastEvidenceCount,
    gen2TemporalLaunchClaimPresent,
    reservationHeld,
    settlementPresent,
    releasePresent,
    chainReconOk: recon.ok,
    globalRelayEnabled: input.globalRelayEnabled,
    deployShaOk: sha.ok,
    signerReady: input.signerReady,
    signerUnlocked: input.signerUnlocked,
    expectedGen2RunId: input.expectedGen2RunId,
    priorWorkflowFound: input.priorWorkflowFound,
    observedPriorRunId: input.observedPriorRunId,
    priorWorkflowStatus: input.priorWorkflowStatus,
    workflowStillRunning: input.workflowStillRunning,
    durableGen2Terminal,
  });
  checks.push(
    check(
      'temporal_launch_eligibility',
      eligibility.eligible,
      eligibility.eligible
        ? 'Gen-3 Temporal launch eligibility PASS'
        : `eligibility refused: ${eligibility.reason}`,
    ),
  );

  const hardFails = checks.filter((c) => c.status === 'FAIL');
  const ok = hardFails.length === 0 && eligibility.eligible;
  return {
    ok,
    mode: 'PLAN',
    withdrawalId: input.withdrawalId,
    publicId,
    workflowId,
    readyForExecute: ok,
    checks,
    gen1PermitStatus,
    gen1ConsumedAttemptId,
    gen2PermitId,
    gen2PermitStatus,
    gen2ConsumedAttemptId,
    gen2TemporalLaunchClaimPresent,
    gen3PermitId,
    gen3PermitStatus,
    attemptCount,
    reservationHeld,
    globalRelayEnabled: input.globalRelayEnabled,
    priorWorkflowIdentityMode: identity.identityMode,
    startOptions: ok
      ? buildPhase21Gen3TemporalLaunchStartOptions({
          withdrawalId: input.withdrawalId,
          taskQueue: input.taskQueue,
        })
      : null,
    broadcastPerformed: false,
    signed: false,
    mutated: false,
    relayEnabled: false,
  };
}

/**
 * Minimal Temporal client surface for Gen-3 launch.
 * Kept intentionally loose so `@temporalio/client` Client is assignable without
 * coupling withdrawals to Temporal enum package versions.
 */
export interface Phase21Gen3TemporalStarter {
  workflow: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start(type: string, options: any): Promise<{ firstExecutionRunId: string }>;
  };
}

/**
 * Lock WD-000001 + permit rows + attempt rows and revalidate claim preconditions
 * inside the caller's open write transaction (must run before outbox claim insert).
 */
export async function revalidatePhase21Gen3TemporalLaunchClaimState(input: {
  readonly client: PoolClient;
  readonly withdrawalId: string;
  readonly gen3PermitId: string;
  readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
  readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
  readonly allowNonCanaryWithdrawalIdForTests?: boolean;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly refuseCode: string }> {
  const canaryOk =
    input.withdrawalId === PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  if (!canaryOk) {
    return { ok: false, refuseCode: 'CLAIM_WITHDRAWAL_NOT_AUTHORIZED' };
  }

  const recon = evaluatePhase21Gen3ChainReconciliationFreshness(input.chainReconciliation);
  if (!recon.ok) {
    return { ok: false, refuseCode: 'CLAIM_CHAIN_RECON_' + String(recon.reason).toUpperCase() };
  }

  const env = input.deploymentEnvironment ?? 'PRODUCTION';
  const paused = await isPayoutDispatchPaused(input.client, env);
  if (paused !== true) {
    return { ok: false, refuseCode: 'CLAIM_PAYOUT_PAUSE_NOT_ON' };
  }

  const wd = await input.client.query<{
    id: string;
    public_id: string;
    state: string;
    reservation_ledger_tx_id: string | null;
    settlement_ledger_tx_id: string | null;
    release_ledger_tx_id: string | null;
  }>(
    `SELECT id::text AS id, public_id, state::text AS state,
            reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
            settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
            release_ledger_tx_id::text AS release_ledger_tx_id
     FROM withdrawals
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.withdrawalId],
  );
  const withdrawal = wd.rows[0];
  if (withdrawal === undefined) {
    return { ok: false, refuseCode: 'CLAIM_WITHDRAWAL_MISSING' };
  }
  if (
    input.allowNonCanaryWithdrawalIdForTests !== true &&
    withdrawal.public_id !== PHASE21_CANARY_PAYOUT_PUBLIC_ID
  ) {
    return { ok: false, refuseCode: 'CLAIM_PUBLIC_ID_MISMATCH' };
  }
  if (withdrawal.state !== 'FAILED_PRE_BROADCAST' && withdrawal.state !== 'QUEUED') {
    return { ok: false, refuseCode: 'CLAIM_WITHDRAWAL_STATE_REFUSED' };
  }
  if (withdrawal.reservation_ledger_tx_id === null) {
    return { ok: false, refuseCode: 'CLAIM_RESERVATION_NOT_HELD' };
  }
  if (withdrawal.settlement_ledger_tx_id !== null) {
    return { ok: false, refuseCode: 'CLAIM_ALREADY_SETTLED' };
  }
  if (withdrawal.release_ledger_tx_id !== null) {
    return { ok: false, refuseCode: 'CLAIM_ALREADY_RELEASED' };
  }

  const permits = await input.client.query<{
    id: string;
    authorization_generation: number;
    status: string;
    consumed_attempt_id: string | null;
  }>(
    `SELECT id::text AS id,
            authorization_generation,
            status::text AS status,
            consumed_attempt_id::text AS consumed_attempt_id
     FROM phase21_manual_dispatch_permits
     WHERE withdrawal_id = $1::uuid
     ORDER BY authorization_generation
     FOR UPDATE`,
    [input.withdrawalId],
  );
  const gen1 = permits.rows.find((p) => Number(p.authorization_generation) === 1);
  const gen2 = permits.rows.find(
    (p) => Number(p.authorization_generation) === PHASE21_GEN2_AUTHORIZATION_GENERATION,
  );
  const gen3 = permits.rows.find(
    (p) => Number(p.authorization_generation) === PHASE21_GEN3_AUTHORIZATION_GENERATION,
  );
  if (gen1 === undefined || gen1.status !== 'CONSUMED' || gen1.consumed_attempt_id === null) {
    return { ok: false, refuseCode: 'CLAIM_GEN1_NOT_CONSUMED' };
  }
  if (gen2 === undefined || gen2.status !== 'CONSUMED' || gen2.consumed_attempt_id === null) {
    return { ok: false, refuseCode: 'CLAIM_GEN2_NOT_CONSUMED' };
  }
  if (gen1.consumed_attempt_id === gen2.consumed_attempt_id) {
    return { ok: false, refuseCode: 'CLAIM_GEN2_ATTEMPT_SAME_AS_GEN1' };
  }
  if (gen3 === undefined || gen3.status !== 'ARMED' || gen3.id !== input.gen3PermitId) {
    return { ok: false, refuseCode: 'CLAIM_GEN3_NOT_ARMED' };
  }
  if (gen3.id === gen1.id || gen3.id === gen2.id) {
    return { ok: false, refuseCode: 'CLAIM_GEN3_PRIOR_PERMIT_REUSE' };
  }

  const gen2ClaimPresent = await readPhase21Gen2TemporalLaunchClaimPresent(input.client, {
    withdrawalId: input.withdrawalId,
    gen2PermitId: gen2.id,
  });
  if (!gen2ClaimPresent) {
    return { ok: false, refuseCode: 'CLAIM_GEN2_LAUNCH_CLAIM_MISSING' };
  }

  // Lock attempt rows first (FOR UPDATE cannot combine with aggregates).
  const attempts = await input.client.query<{
    attempt_number: number;
    broadcast_result_state: string;
    has_evidence: boolean;
  }>(
    `SELECT attempt_number,
            broadcast_result_state::text AS broadcast_result_state,
            (
              signed_external_message_boc IS NOT NULL
              OR signed_wallet_request_boc IS NOT NULL
              OR external_message_cell_hash IS NOT NULL
              OR normalized_external_message_hash IS NOT NULL
              OR signed_message_hash IS NOT NULL
              OR broadcast_submitted_at IS NOT NULL
              OR broadcast_started_at IS NOT NULL
              OR (chain_reference IS NOT NULL AND btrim(chain_reference) <> '')
            ) AS has_evidence
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     FOR UPDATE`,
    [input.withdrawalId],
  );
  const attemptCount = attempts.rows.length;
  const failedPre = attempts.rows.filter(
    (r) => r.broadcast_result_state === 'FAILED_PRE_BROADCAST',
  ).length;
  const evidence = attempts.rows.filter((r) => r.has_evidence === true).length;
  const attempt1FailedPre = attempts.rows.some(
    (r) =>
      Number(r.attempt_number) === 1 && r.broadcast_result_state === 'FAILED_PRE_BROADCAST',
  );
  const attempt2FailedPre = attempts.rows.some(
    (r) =>
      Number(r.attempt_number) === 2 && r.broadcast_result_state === 'FAILED_PRE_BROADCAST',
  );
  if (
    !isPhase21Gen3AttemptShapeAccepted({
      attemptCount,
      failedPreAttemptCount: failedPre,
      evidenceCount: evidence,
      attempt1FailedPre,
      attempt2FailedPre,
    })
  ) {
    return { ok: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' };
  }

  return { ok: true };
}

/**
 * Atomically claim Gen-3 Temporal one-shot launch via unique outbox dedupe_key.
 * Caller must BEGIN a write transaction first. This locks/revalidates WD-000001
 * state, rechecks chain-recon freshness, then inserts DISPATCHED claim
 * (not PENDING — outbox relays never pick it up). COMMIT is caller's responsibility
 * and must happen before Temporal start.
 */
export async function claimPhase21Gen3TemporalLaunch(input: {
  readonly client: PoolClient;
  readonly withdrawalId: string;
  readonly gen3PermitId: string;
  readonly expectedGen2RunId: string;
  readonly identityMode: Phase21Gen3PriorWorkflowIdentityMode | null;
  readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
  readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
  readonly allowNonCanaryWithdrawalIdForTests?: boolean;
}): Promise<
  | { readonly created: true; readonly dedupeKey: string }
  | { readonly created: false; readonly dedupeKey: string; readonly refuseCode: string }
> {
  const dedupeKey = buildPhase21Gen3TemporalLaunchClaimDedupeKey({
    withdrawalId: input.withdrawalId,
    gen3PermitId: input.gen3PermitId,
  });

  const revalidated = await revalidatePhase21Gen3TemporalLaunchClaimState({
    client: input.client,
    withdrawalId: input.withdrawalId,
    gen3PermitId: input.gen3PermitId,
    chainReconciliation: input.chainReconciliation,
    ...(input.deploymentEnvironment !== undefined
      ? { deploymentEnvironment: input.deploymentEnvironment }
      : {}),
    ...(input.allowNonCanaryWithdrawalIdForTests !== undefined
      ? { allowNonCanaryWithdrawalIdForTests: input.allowNonCanaryWithdrawalIdForTests }
      : {}),
  });
  if (!revalidated.ok) {
    return { created: false, dedupeKey, refuseCode: revalidated.refuseCode };
  }

  const payload = {
    withdrawalId: input.withdrawalId,
    gen3PermitId: input.gen3PermitId,
    expectedGen2RunId: input.expectedGen2RunId,
    identityMode: input.identityMode,
    workflowId: withdrawalWorkflowId(input.withdrawalId),
    authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
    broadcastPerformed: false,
    signed: false,
  };
  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO outbox_events (
       aggregate_type, aggregate_id, event_type, payload, dedupe_key,
       status, available_at, dispatched_at
     ) VALUES (
       'withdrawal', $1::uuid, $2, $3::jsonb, $4,
       'DISPATCHED'::outbox_event_status, now(), now()
     )
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.withdrawalId,
      PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
      JSON.stringify(payload),
      dedupeKey,
    ],
  );
  if (inserted.rows[0]?.id === undefined) {
    return { created: false, dedupeKey, refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED' };
  }
  return { created: true, dedupeKey };
}

/**
 * EXECUTE: Owner ACK + prior PLAN ready → durable one-shot claim → start exactly one workflow.
 * Does not enable relay, sign, or broadcast.
 */
export async function executePhase21Gen3TemporalLaunch(input: {
  readonly confirmationPhrase: string;
  readonly plan: Phase21Gen3TemporalLaunchPlanResult;
  readonly temporal: Phase21Gen3TemporalStarter;
  /** Required for durable one-shot claim (same DB as PLAN). */
  readonly claimClient: PoolClient;
  readonly expectedGen2RunId: string;
  /** Fresh independent chain recon — freshness rechecked inside the claim transaction. */
  readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
  readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
  /** Disposable tests only — production never sets this. */
  readonly allowNonCanaryWithdrawalIdForTests?: boolean;
}): Promise<{
  readonly ok: boolean;
  readonly started: boolean;
  readonly runId: string | null;
  readonly workflowId: string;
  readonly refuseCode?: string;
  readonly relayEnabled: false;
  readonly broadcastPerformed: false;
  readonly signed: false;
}> {
  const refuse = (refuseCode: string) =>
    ({
      ok: false,
      started: false,
      runId: null,
      workflowId: input.plan.workflowId,
      refuseCode,
      relayEnabled: false,
      broadcastPerformed: false,
      signed: false,
    }) as const;

  try {
    assertPhase21Gen3TemporalLaunchAck(input.confirmationPhrase);
  } catch {
    return refuse('OWNER_ACK_REQUIRED');
  }
  if (!input.plan.ok || !input.plan.readyForExecute || input.plan.startOptions === null) {
    return refuse('PLAN_NOT_READY');
  }
  if (input.plan.globalRelayEnabled === true) {
    return refuse('GLOBAL_RELAY_MUST_REMAIN_OFF');
  }
  if (input.plan.gen3PermitId === null || input.plan.gen3PermitId.trim() === '') {
    return refuse('GEN3_PERMIT_ID_REQUIRED');
  }
  if (
    input.plan.gen2PermitId !== null &&
    input.plan.gen2PermitId === input.plan.gen3PermitId
  ) {
    return refuse('GEN3_PRIOR_PERMIT_REUSE_REFUSED');
  }
  if (input.plan.gen2TemporalLaunchClaimPresent !== true) {
    return refuse('GEN2_LAUNCH_CLAIM_MISSING');
  }

  await input.claimClient.query('BEGIN');
  let claimed = false;
  try {
    const claim = await claimPhase21Gen3TemporalLaunch({
      client: input.claimClient,
      withdrawalId: input.plan.withdrawalId,
      gen3PermitId: input.plan.gen3PermitId,
      expectedGen2RunId: input.expectedGen2RunId,
      identityMode: input.plan.priorWorkflowIdentityMode,
      chainReconciliation: input.chainReconciliation,
      ...(input.deploymentEnvironment !== undefined
        ? { deploymentEnvironment: input.deploymentEnvironment }
        : {}),
      ...(input.allowNonCanaryWithdrawalIdForTests !== undefined
        ? { allowNonCanaryWithdrawalIdForTests: input.allowNonCanaryWithdrawalIdForTests }
        : {}),
    });
    if (!claim.created) {
      await input.claimClient.query('ROLLBACK');
      return refuse(claim.refuseCode);
    }
    claimed = true;
    await input.claimClient.query('COMMIT');
  } catch (error) {
    try {
      await input.claimClient.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw error;
  }

  const opts = input.plan.startOptions;
  try {
    const handle = await input.temporal.workflow.start(opts.workflowType, {
      taskQueue: opts.taskQueue,
      workflowId: opts.workflowId,
      args: [...opts.args],
      workflowIdReusePolicy: opts.workflowIdReusePolicy,
      workflowIdConflictPolicy: opts.workflowIdConflictPolicy,
    });
    return {
      ok: true,
      started: true,
      runId: handle.firstExecutionRunId,
      workflowId: opts.workflowId,
      relayEnabled: false,
      broadcastPerformed: false,
      signed: false,
    };
  } catch (error) {
    // Claim remains (fail closed): do not auto-retry or clear claim after ambiguous start.
    void claimed;
    throw error;
  }
}
