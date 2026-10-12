/**
 * Phase 21 Gen-2 Owner-authorized one-shot Temporal launch — PLAN + EXECUTE design.
 *
 * Separate from Gen-2 permit APPLY (which only arms + enqueues outbox).
 * Global outbox relay must remain OFF; this path starts exactly one
 * withdrawal/{id} workflow under Owner confirmation after fresh gates.
 *
 * Never signs, never broadcasts, never enables relay, never mutates permits.
 * Temporal start uses ALLOW_DUPLICATE + FAIL conflict (same as Phase21 manual dispatch).
 * Real-chain activity maximumAttempts=1 remains in Worker workflow definition.
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
import {
  evaluatePhase21Gen2ChainReconciliationFreshness,
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  type Phase21Gen2IndependentChainReconciliation,
} from './phase21-gen2-recovery-plan.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration,
} from './phase21-manual-dispatch-permit.js';
import {
  evaluatePhase21Gen2ConsumedFailedPreRecovery,
  isPhase21CanaryPriorWorkflowSafeToRestart,
} from './phase21-resume-canary-gates.js';
import { withdrawalWorkflowId } from './outbox.js';

export const PHASE21_GEN2_TEMPORAL_LAUNCH_ACK =
  'I_AUTHORIZE_WD_000001_GEN2_TEMPORAL_ONE_SHOT' as const;

export const PHASE21_GEN2_TEMPORAL_LAUNCH_WORKFLOW_TYPE = 'withdrawalPayoutWorkflow' as const;
export const PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY = 'ALLOW_DUPLICATE' as const;
export const PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY = 'FAIL' as const;

export interface Phase21Gen2TemporalLaunchStartOptions {
  readonly workflowType: typeof PHASE21_GEN2_TEMPORAL_LAUNCH_WORKFLOW_TYPE;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly args: readonly [{ readonly withdrawalId: string; readonly realChainEnabled: true }];
  readonly workflowIdReusePolicy: typeof PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY;
  readonly workflowIdConflictPolicy: typeof PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY;
}

export function buildPhase21Gen2TemporalLaunchStartOptions(input: {
  readonly withdrawalId: string;
  readonly taskQueue: string;
}): Phase21Gen2TemporalLaunchStartOptions {
  return {
    workflowType: PHASE21_GEN2_TEMPORAL_LAUNCH_WORKFLOW_TYPE,
    workflowId: withdrawalWorkflowId(input.withdrawalId),
    taskQueue: input.taskQueue,
    args: [{ withdrawalId: input.withdrawalId, realChainEnabled: true }],
    workflowIdReusePolicy: PHASE21_GEN2_TEMPORAL_LAUNCH_REUSE_POLICY,
    workflowIdConflictPolicy: PHASE21_GEN2_TEMPORAL_LAUNCH_CONFLICT_POLICY,
  };
}

export function assertPhase21Gen2TemporalLaunchAck(phrase: string): void {
  if (phrase !== PHASE21_GEN2_TEMPORAL_LAUNCH_ACK) {
    throw new Error('PRECHECK_FAILED_OWNER_ACK');
  }
}

/** Normalize full or short SHA for equality (require >= 7 hex chars). */
export function evaluatePhase21Gen2LiveDeployShaMatch(input: {
  readonly expectedDeploySha: string | null | undefined;
  readonly liveDeploySha: string | null | undefined;
}): { readonly ok: boolean; readonly reason: string | null } {
  const expected = (input.expectedDeploySha ?? '').trim().toLowerCase();
  const live = (input.liveDeploySha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(expected)) {
    return { ok: false, reason: 'expected_deploy_sha_invalid' };
  }
  if (!/^[0-9a-f]{7,40}$/.test(live)) {
    return { ok: false, reason: 'live_deploy_sha_invalid' };
  }
  if (expected === live) {
    return { ok: true, reason: null };
  }
  if (live.startsWith(expected) || expected.startsWith(live)) {
    return { ok: true, reason: null };
  }
  return { ok: false, reason: 'deploy_sha_mismatch' };
}

/**
 * Pure eligibility for Gen-2 Temporal one-shot launch (after Gen-2 permit already ARMED).
 */
export function evaluatePhase21Gen2TemporalLaunchEligibility(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen2AuthorizationGeneration: number;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly reservationHeld: boolean;
  readonly settlementPresent: boolean;
  readonly releasePresent: boolean;
  readonly chainReconOk: boolean;
  readonly globalRelayEnabled: boolean;
  readonly deployShaOk: boolean;
  readonly signerReady: boolean;
  readonly signerUnlocked: boolean;
  readonly priorWorkflowStatus: string;
  readonly workflowStillRunning: boolean;
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

  const base = evaluatePhase21Gen2ConsumedFailedPreRecovery({
    withdrawalState: input.withdrawalState,
    gen1PermitStatus: input.gen1PermitStatus,
    gen2PermitStatus: input.gen2PermitStatus,
    gen2AuthorizationGeneration: input.gen2AuthorizationGeneration,
    attemptCount: input.attemptCount,
    failedPreAttemptCount: input.failedPreAttemptCount,
    broadcastEvidenceCount: input.broadcastEvidenceCount,
    priorWorkflowStatus: input.priorWorkflowStatus,
  });
  if (!base.eligible) {
    return base;
  }
  if (!isPhase21CanaryPriorWorkflowSafeToRestart(input.priorWorkflowStatus)) {
    return { eligible: false, reason: 'prior_workflow_not_safe' };
  }
  return { eligible: true, reason: null };
}

export interface Phase21Gen2TemporalLaunchPlanResult {
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
  readonly attemptCount: number;
  readonly reservationHeld: boolean;
  readonly globalRelayEnabled: false | true;
  readonly startOptions: Phase21Gen2TemporalLaunchStartOptions | null;
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
 * Read-only PLAN for Gen-2 Temporal launch. Does not start Temporal.
 * Caller supplies fresh chain recon, deploy SHA evidence, signer + Temporal observations.
 */
export async function planPhase21Gen2TemporalLaunch(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly chainReconciliation: Phase21Gen2IndependentChainReconciliation;
    readonly expectedDeploySha: string;
    readonly liveDeploySha: string;
    readonly globalRelayEnabled: boolean;
    readonly signerReady: boolean;
    readonly signerUnlocked: boolean;
    readonly priorWorkflowStatus: string;
    readonly workflowStillRunning: boolean;
    readonly taskQueue: string;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen2TemporalLaunchPlanResult> {
  const checks: Phase21CanaryPayoutCheck[] = [];
  const env = input.deploymentEnvironment ?? 'LOCAL';
  const workflowId = withdrawalWorkflowId(input.withdrawalId);

  const canaryIdOk =
    input.withdrawalId === PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  checks.push(
    check('withdrawal_id_authorized', canaryIdOk, 'Gen-2 Temporal launch hard-binds to canary (or test override)', {
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

  const sha = evaluatePhase21Gen2LiveDeployShaMatch({
    expectedDeploySha: input.expectedDeploySha,
    liveDeploySha: input.liveDeploySha,
  });
  checks.push(
    check('live_deploy_sha', sha.ok, sha.ok ? 'live Worker deploy SHA matches Owner expected' : `sha refused: ${sha.reason}`, {
      expected: input.expectedDeploySha,
      actual: input.liveDeploySha,
    }),
  );

  const recon = evaluatePhase21Gen2ChainReconciliationFreshness(input.chainReconciliation);
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

  checks.push(
    check(
      'prior_workflow_safe',
      isPhase21CanaryPriorWorkflowSafeToRestart(input.priorWorkflowStatus),
      'prior Temporal status must be closed/safe for ALLOW_DUPLICATE',
      { actual: input.priorWorkflowStatus },
    ),
  );

  let publicId: string = PHASE21_CANARY_PAYOUT_PUBLIC_ID;
  let gen1PermitStatus: string | null = null;
  let gen1ConsumedAttemptId: string | null = null;
  let gen2PermitId: string | null = null;
  let gen2PermitStatus: string | null = null;
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
      checks.push(
        check('gen2_armed', gen2?.status === 'ARMED', 'Gen-2 permit must be ARMED before Temporal launch', {
          actual: gen2PermitStatus,
        }),
      );
      checks.push(
        check(
          'gen2_not_gen1_reuse',
          gen2 !== null && gen1 !== null && gen2.id !== gen1.id,
          'Gen-2 permit id must differ from Gen-1 (never reuse Gen-1 permit)',
        ),
      );

      const attempts = await client.query<{
        c: number;
        failed_pre: number;
        evidence: number;
        attempt1_failed_pre: number;
      }>(
        `SELECT count(*)::int AS c,
                count(*) FILTER (
                  WHERE broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
                )::int AS failed_pre,
                count(*) FILTER (
                  WHERE signed_external_message_boc IS NOT NULL
                     OR signed_wallet_request_boc IS NOT NULL
                     OR external_message_cell_hash IS NOT NULL
                     OR normalized_external_message_hash IS NOT NULL
                     OR signed_message_hash IS NOT NULL
                     OR broadcast_submitted_at IS NOT NULL
                     OR broadcast_started_at IS NOT NULL
                     OR (chain_reference IS NOT NULL AND btrim(chain_reference) <> '')
                )::int AS evidence,
                count(*) FILTER (
                  WHERE attempt_number = 1
                    AND broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
                )::int AS attempt1_failed_pre
         FROM withdrawal_attempts
         WHERE withdrawal_id = $1::uuid`,
        [input.withdrawalId],
      );
      attemptCount = attempts.rows[0]?.c ?? 0;
      failedPreAttemptCount = attempts.rows[0]?.failed_pre ?? 0;
      broadcastEvidenceCount = attempts.rows[0]?.evidence ?? 0;
      const attempt1FailedPre = (attempts.rows[0]?.attempt1_failed_pre ?? 0) === 1;
      checks.push(
        check(
          'attempt1_failed_pre_no_evidence',
          attemptCount >= 1 &&
            failedPreAttemptCount === attemptCount &&
            broadcastEvidenceCount === 0 &&
            attempt1FailedPre,
          'attempt #1 FAILED_PRE with zero broadcast/signature evidence; never re-sign attempt #1',
          {
            actual: {
              attemptCount,
              failedPreAttemptCount,
              broadcastEvidenceCount,
              attempt1FailedPre,
            },
          },
        ),
      );
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

  const eligibility = evaluatePhase21Gen2TemporalLaunchEligibility({
    withdrawalState,
    gen1PermitStatus: gen1PermitStatus ?? '',
    gen2PermitStatus: gen2PermitStatus ?? '',
    gen2AuthorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
    attemptCount,
    failedPreAttemptCount,
    broadcastEvidenceCount,
    reservationHeld,
    settlementPresent,
    releasePresent,
    chainReconOk: recon.ok,
    globalRelayEnabled: input.globalRelayEnabled,
    deployShaOk: sha.ok,
    signerReady: input.signerReady,
    signerUnlocked: input.signerUnlocked,
    priorWorkflowStatus: input.priorWorkflowStatus,
    workflowStillRunning: input.workflowStillRunning,
  });
  checks.push(
    check(
      'temporal_launch_eligibility',
      eligibility.eligible,
      eligibility.eligible
        ? 'Gen-2 Temporal launch eligibility PASS'
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
    attemptCount,
    reservationHeld,
    globalRelayEnabled: input.globalRelayEnabled,
    startOptions: ok
      ? buildPhase21Gen2TemporalLaunchStartOptions({
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
 * Minimal Temporal client surface for Gen-2 launch.
 * Kept intentionally loose so `@temporalio/client` Client is assignable without
 * coupling withdrawals to Temporal enum package versions.
 */
export interface Phase21Gen2TemporalStarter {
  workflow: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start(type: string, options: any): Promise<{ firstExecutionRunId: string }>;
  };
}

/**
 * EXECUTE: Owner ACK + prior PLAN ready → start exactly one workflow.
 * Does not enable relay, sign, or broadcast.
 */
export async function executePhase21Gen2TemporalLaunch(input: {
  readonly confirmationPhrase: string;
  readonly plan: Phase21Gen2TemporalLaunchPlanResult;
  readonly temporal: Phase21Gen2TemporalStarter;
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
  try {
    assertPhase21Gen2TemporalLaunchAck(input.confirmationPhrase);
  } catch {
    return {
      ok: false,
      started: false,
      runId: null,
      workflowId: input.plan.workflowId,
      refuseCode: 'OWNER_ACK_REQUIRED',
      relayEnabled: false,
      broadcastPerformed: false,
      signed: false,
    };
  }
  if (!input.plan.ok || !input.plan.readyForExecute || input.plan.startOptions === null) {
    return {
      ok: false,
      started: false,
      runId: null,
      workflowId: input.plan.workflowId,
      refuseCode: 'PLAN_NOT_READY',
      relayEnabled: false,
      broadcastPerformed: false,
      signed: false,
    };
  }
  if (input.plan.globalRelayEnabled === true) {
    return {
      ok: false,
      started: false,
      runId: null,
      workflowId: input.plan.workflowId,
      refuseCode: 'GLOBAL_RELAY_MUST_REMAIN_OFF',
      relayEnabled: false,
      broadcastPerformed: false,
      signed: false,
    };
  }

  const opts = input.plan.startOptions;
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
}
