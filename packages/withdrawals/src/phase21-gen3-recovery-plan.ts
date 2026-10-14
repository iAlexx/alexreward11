/**
 * Phase 21 Generation-3 Owner-authorized recovery — PLAN (read-only).
 *
 * Proves WD-000001 is safe for a fresh Gen-3 one-shot permit after:
 *   - Gen-1 CONSUMED → attempt #1 FAILED_PRE_BROADCAST (no evidence), and
 *   - Gen-2 CONSUMED → attempt #2 FAILED_PRE_BROADCAST (no evidence; a
 *     signed-but-lost Signer response is tolerated ONLY when no BOC / hash /
 *     submit / chain reference was ever persisted).
 *
 * Exactly two prior attempts are required (Gen-2 required exactly one).
 * Never mutates DB, never arms permits, never signs, never broadcasts.
 *
 * Requires independent dual-provider chain reconciliation evidence supplied by
 * the caller (must be fresh — PLAN refuses stale / missing / non-HIGH confidence).
 * Missing Temporal history or a lost Signer response never implies "no payment";
 * fresh HIGH chain recon is the only acceptable proof.
 */
import type { PoolClient } from 'pg';

import { isPayoutDispatchPaused } from './flags.js';
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
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS,
  evaluatePhase21Gen2ChainReconciliationFreshness,
  mintPhase21Gen2IndependentChainReconciliationForTests,
  type Phase21Gen2IndependentChainReconciliation,
} from './phase21-gen2-recovery-plan.js';
import { buildPhase21Gen2TemporalLaunchClaimDedupeKey } from './phase21-gen2-temporal-launch.js';
import { getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration } from './phase21-manual-dispatch-permit.js';
import {
  isPhase21CanaryPriorWorkflowSafeToRestart,
  isPhase21CanaryWithdrawalStateAllowedForResume,
} from './phase21-resume-canary-gates.js';

export const PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
export const PHASE21_GEN3_RECOVERY_PUBLIC_ID = PHASE21_CANARY_PAYOUT_PUBLIC_ID;
export const PHASE21_GEN3_AUTHORIZATION_GENERATION = 3 as const;

/** Exactly this many prior attempts (#1 Gen-1, #2 Gen-2) must exist before Gen-3. */
export const PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT = 2 as const;

/** Max age for independent chain reconciliation evidence before PLAN/APPLY refuse (same as Gen-2). */
export const PHASE21_GEN3_CHAIN_RECON_MAX_AGE_MS = PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS;

/**
 * Gen-3 chain reconciliation contract is identical to Gen-2
 * (providersIndependent, paymentObserved=false, recipientUsdtTransferObserved=false,
 * confidence HIGH, distinct providers, max age 15 min).
 */
export type Phase21Gen3IndependentChainReconciliation = Phase21Gen2IndependentChainReconciliation;

/** Durable status token used when Temporal history is absent but durable Gen-2 terminal evidence holds. */
export const PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS =
  'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN2_TERMINAL' as const;

export interface Phase21Gen3RecoveryPlanResult {
  readonly ok: boolean;
  readonly mode: 'PLAN';
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: number;
  readonly readyForGen3Apply: boolean;
  readonly checks: readonly Phase21CanaryPayoutCheck[];
  readonly gen1PermitStatus: string | null;
  readonly gen1ConsumedAttemptId: string | null;
  readonly gen2PermitStatus: string | null;
  readonly gen2ConsumedAttemptId: string | null;
  readonly gen2TemporalLaunchClaimPresent: boolean;
  readonly gen3PermitStatus: string | null;
  readonly attemptCount: number;
  readonly reservationHeld: boolean;
  readonly generalDispatchPausePreserved: boolean;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly mutated: false;
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

export function evaluatePhase21Gen3ChainReconciliationFreshness(
  evidence: Phase21Gen3IndependentChainReconciliation | null | undefined,
  nowMs: number = Date.now(),
): { readonly ok: boolean; readonly reason: string | null } {
  return evaluatePhase21Gen2ChainReconciliationFreshness(evidence, nowMs);
}

export function mintPhase21Gen3IndependentChainReconciliationForTests(input?: {
  readonly performedAt?: string;
  readonly hotWalletAccountActive?: boolean;
  readonly detail?: string;
}): Phase21Gen3IndependentChainReconciliation {
  return mintPhase21Gen2IndependentChainReconciliationForTests({
    ...(input?.performedAt !== undefined ? { performedAt: input.performedAt } : {}),
    ...(input?.hotWalletAccountActive !== undefined
      ? { hotWalletAccountActive: input.hotWalletAccountActive }
      : {}),
    detail:
      input?.detail ??
      'test: dual-provider HIGH confidence no USDT payout observed (Gen-3 recon contract)',
  });
}

/**
 * Prior Temporal status safe for Gen-3 ALLOW_DUPLICATE restart.
 * Accepts the durable Gen-2 terminal token in addition to live closed statuses.
 */
export function isPhase21Gen3PriorWorkflowSafeToRestart(statusName: string): boolean {
  if (statusName.trim().toUpperCase() === PHASE21_GEN3_TEMPORAL_HISTORY_ABSENT_STATUS) {
    return true;
  }
  return isPhase21CanaryPriorWorkflowSafeToRestart(statusName);
}

/**
 * Pure eligibility helper for Gen-3 recovery after Gen-1 + Gen-2 CONSUMED and
 * exactly two FAILED_PRE attempts with no durable signing/broadcast evidence.
 */
export function evaluatePhase21Gen3RecoveryEligibility(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen3PermitStatus: string | null;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly signatureOrBroadcastEvidenceCount: number;
  readonly reservationHeld: boolean;
  readonly settlementPresent: boolean;
  readonly releasePresent: boolean;
  readonly chainReconOk: boolean;
}): { readonly eligible: boolean; readonly reason: string | null } {
  if (
    input.withdrawalState !== 'FAILED_PRE_BROADCAST' &&
    input.withdrawalState !== 'QUEUED'
  ) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (input.gen1PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen1_not_consumed' };
  }
  if (input.gen2PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen2_not_consumed' };
  }
  if (input.gen3PermitStatus === 'CANCELLED') {
    return { eligible: false, reason: 'gen3_cancelled' };
  }
  if (input.attemptCount !== PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT) {
    return { eligible: false, reason: 'prior_attempt_count_not_two' };
  }
  if (input.failedPreAttemptCount !== input.attemptCount) {
    return { eligible: false, reason: 'non_failed_pre_attempts' };
  }
  if (input.signatureOrBroadcastEvidenceCount !== 0) {
    return { eligible: false, reason: 'signature_or_broadcast_evidence' };
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
  if (!input.chainReconOk) {
    return { eligible: false, reason: 'chain_recon_required' };
  }
  return { eligible: true, reason: null };
}

/**
 * Owner-gated Gen-3 resume eligibility (mirrors evaluatePhase21Gen2ConsumedFailedPreRecovery):
 * live ARMED Gen-3 permit, Gen-1 + Gen-2 CONSUMED, exactly two FAILED_PRE attempts with
 * no evidence, and a prior Temporal status safe to restart (or durable Gen-2 terminal).
 */
export function evaluatePhase21Gen3ConsumedFailedPreRecovery(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen3PermitStatus: string;
  readonly gen3AuthorizationGeneration: number;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly priorWorkflowStatus: string;
}): {
  readonly eligible: boolean;
  readonly reason: string | null;
} {
  if (
    input.withdrawalState !== 'FAILED_PRE_BROADCAST' &&
    input.withdrawalState !== 'QUEUED'
  ) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (!isPhase21CanaryWithdrawalStateAllowedForResume(input.withdrawalState)) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (input.gen1PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen1_not_consumed' };
  }
  if (input.gen2PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen2_not_consumed' };
  }
  if (input.gen3PermitStatus !== 'ARMED') {
    return { eligible: false, reason: 'gen3_not_armed' };
  }
  if (input.gen3AuthorizationGeneration !== PHASE21_GEN3_AUTHORIZATION_GENERATION) {
    return { eligible: false, reason: 'gen3_generation_invalid' };
  }
  if (input.attemptCount !== PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT) {
    return { eligible: false, reason: 'prior_attempt_count_not_two' };
  }
  if (input.failedPreAttemptCount !== input.attemptCount) {
    return { eligible: false, reason: 'non_failed_pre_attempts' };
  }
  if (input.broadcastEvidenceCount !== 0) {
    return { eligible: false, reason: 'broadcast_evidence_exists' };
  }
  if (!isPhase21Gen3PriorWorkflowSafeToRestart(input.priorWorkflowStatus)) {
    return { eligible: false, reason: 'prior_workflow_not_safe' };
  }
  return { eligible: true, reason: null };
}

/** Aggregated attempt shape used by PLAN / APPLY revalidation / Temporal launch. */
export interface Phase21Gen3AttemptShape {
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly evidenceCount: number;
  readonly attempt1FailedPre: boolean;
  readonly attempt2FailedPre: boolean;
}

export function isPhase21Gen3AttemptShapeAccepted(shape: Phase21Gen3AttemptShape): boolean {
  return (
    shape.attemptCount === PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT &&
    shape.failedPreAttemptCount === shape.attemptCount &&
    shape.evidenceCount === 0 &&
    shape.attempt1FailedPre &&
    shape.attempt2FailedPre
  );
}

/** Read-only aggregate (no locks). Callers needing FOR UPDATE lock rows first. */
export async function readPhase21Gen3AttemptShape(
  client: Pick<PoolClient, 'query'>,
  withdrawalId: string,
): Promise<Phase21Gen3AttemptShape> {
  const attempts = await client.query<{
    c: number;
    failed_pre: number;
    evidence: number;
    attempt1_failed_pre: number;
    attempt2_failed_pre: number;
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
            )::int AS attempt1_failed_pre,
            count(*) FILTER (
              WHERE attempt_number = 2
                AND broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
            )::int AS attempt2_failed_pre
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  const row = attempts.rows[0];
  return {
    attemptCount: row?.c ?? 0,
    failedPreAttemptCount: row?.failed_pre ?? 0,
    evidenceCount: row?.evidence ?? 0,
    attempt1FailedPre: (row?.attempt1_failed_pre ?? 0) === 1,
    attempt2FailedPre: (row?.attempt2_failed_pre ?? 0) === 1,
  };
}

/** Durable Gen-2 Temporal one-shot claim must remain present (DISPATCHED) — never cleared. */
export async function readPhase21Gen2TemporalLaunchClaimPresent(
  client: Pick<PoolClient, 'query'>,
  input: { readonly withdrawalId: string; readonly gen2PermitId: string },
): Promise<boolean> {
  const key = buildPhase21Gen2TemporalLaunchClaimDedupeKey(input);
  const claim = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM outbox_events
     WHERE dedupe_key = $1
       AND status = 'DISPATCHED'::outbox_event_status`,
    [key],
  );
  return (claim.rows[0]?.n ?? 0) === 1;
}

export async function planPhase21Gen3Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    /** Disposable E2E only — production APPLY never sets this. */
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen3RecoveryPlanResult> {
  const checks: Phase21CanaryPayoutCheck[] = [];
  const env = input.deploymentEnvironment ?? 'LOCAL';

  const canaryIdOk =
    input.withdrawalId === PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  checks.push(
    check(
      'withdrawal_id_authorized',
      canaryIdOk,
      'Gen-3 PLAN hard-binds to Owner canary (or disposable test override)',
      { expected: PHASE21_GEN3_RECOVERY_WITHDRAWAL_ID, actual: input.withdrawalId },
    ),
  );

  const recon = evaluatePhase21Gen3ChainReconciliationFreshness(input.chainReconciliation);
  checks.push(
    check(
      'independent_chain_reconciliation',
      recon.ok,
      recon.ok
        ? 'fresh dual-provider HIGH-confidence no-payment recon'
        : `chain recon refused: ${recon.reason}`,
      {
        actual: {
          performedAt: input.chainReconciliation.performedAt,
          confidence: input.chainReconciliation.confidence,
          paymentObserved: input.chainReconciliation.paymentObserved,
          reason: recon.reason,
        },
      },
    ),
  );

  let publicId: string = PHASE21_GEN3_RECOVERY_PUBLIC_ID;
  let gen1PermitStatus: string | null = null;
  let gen1ConsumedAttemptId: string | null = null;
  let gen2PermitStatus: string | null = null;
  let gen2ConsumedAttemptId: string | null = null;
  let gen2TemporalLaunchClaimPresent = false;
  let gen3PermitStatus: string | null = null;
  let attemptCount = 0;
  let reservationHeld = false;
  let generalDispatchPausePreserved = false;

  await client.query('BEGIN READ ONLY');
  try {
    const paused = await isPayoutDispatchPaused(client, env);
    generalDispatchPausePreserved = paused === true;
    checks.push(
      check(
        'payout_dispatch_pause_preserved',
        paused === true,
        'global PAYOUT_DISPATCH_PAUSE must remain ON',
        { expected: true, actual: paused },
      ),
    );

    const w = await client.query<{
      id: string;
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
      `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
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
      const bindOk =
        input.allowNonCanaryWithdrawalIdForTests === true ||
        (row.public_id === PHASE21_GEN3_RECOVERY_PUBLIC_ID &&
          row.requested_amount_atomic ===
            PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10) &&
          row.fee_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10) &&
          row.net_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10) &&
          row.recipient_friendly === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY &&
          row.recipient_raw === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW &&
          row.network_code === PHASE21_NETWORK_CODE);
      checks.push(
        check('frozen_bindings', bindOk, 'amounts/recipient/network match Gen-3 frozen bindings'),
      );

      const stateOk = row.state === 'FAILED_PRE_BROADCAST' || row.state === 'QUEUED';
      checks.push(
        check('withdrawal_state', stateOk, 'state must be FAILED_PRE_BROADCAST or QUEUED', {
          actual: row.state,
        }),
      );

      reservationHeld = row.reservation_ledger_tx_id !== null;
      checks.push(
        check('reservation_held', reservationHeld, 'reuse existing reservation; no double debit'),
      );
      checks.push(
        check('no_settlement', row.settlement_ledger_tx_id === null, 'must not be settled', {
          actual: row.settlement_ledger_tx_id,
        }),
      );
      checks.push(
        check('no_release', row.release_ledger_tx_id === null, 'must not be released', {
          actual: row.release_ledger_tx_id,
        }),
      );

      const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        1,
      );
      gen1PermitStatus = gen1?.status ?? null;
      gen1ConsumedAttemptId = gen1?.consumedAttemptId ?? null;
      checks.push(
        check(
          'gen1_consumed_preserved',
          gen1?.status === 'CONSUMED',
          'Gen-1 CONSUMED permit must remain',
          { actual: gen1PermitStatus },
        ),
      );
      checks.push(
        check(
          'gen1_bound_attempt',
          gen1?.consumedAttemptId != null,
          'Gen-1 must be bound to attempt #1',
          { actual: gen1ConsumedAttemptId },
        ),
      );

      const gen2 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN2_AUTHORIZATION_GENERATION,
      );
      gen2PermitStatus = gen2?.status ?? null;
      gen2ConsumedAttemptId = gen2?.consumedAttemptId ?? null;
      checks.push(
        check(
          'gen2_consumed_preserved',
          gen2?.status === 'CONSUMED',
          'Gen-2 CONSUMED permit must remain (never reuse Gen-2)',
          { actual: gen2PermitStatus },
        ),
      );
      checks.push(
        check(
          'gen2_bound_attempt',
          gen2?.consumedAttemptId != null,
          'Gen-2 must be bound to attempt #2',
          { actual: gen2ConsumedAttemptId },
        ),
      );
      checks.push(
        check(
          'gen2_bound_attempt_differs_from_gen1',
          gen1?.consumedAttemptId != null &&
            gen2?.consumedAttemptId != null &&
            gen1.consumedAttemptId !== gen2.consumedAttemptId,
          'Gen-1 and Gen-2 must be bound to distinct attempts',
        ),
      );

      if (gen2 !== null) {
        gen2TemporalLaunchClaimPresent = await readPhase21Gen2TemporalLaunchClaimPresent(client, {
          withdrawalId: input.withdrawalId,
          gen2PermitId: gen2.id,
        });
      }
      checks.push(
        check(
          'gen2_temporal_launch_claim_preserved',
          gen2TemporalLaunchClaimPresent,
          'durable Gen-2 Temporal one-shot claim must remain DISPATCHED (never cleared)',
          { actual: gen2TemporalLaunchClaimPresent ? 'present' : 'absent' },
        ),
      );

      const gen3 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN3_AUTHORIZATION_GENERATION,
      );
      gen3PermitStatus = gen3?.status ?? null;
      const gen3Ok = gen3 === null || gen3.status === 'ARMED';
      checks.push(
        check(
          'gen3_absent_or_armed',
          gen3Ok,
          'Gen-3 must be absent (fresh) or already ARMED (idempotent)',
          { actual: gen3PermitStatus },
        ),
      );
      checks.push(
        check(
          'gen3_not_prior_generation_reuse',
          gen3 === null ||
            (gen1 !== null && gen2 !== null && gen3.id !== gen1.id && gen3.id !== gen2.id),
          'Gen-3 permit id must differ from Gen-1 and Gen-2 (never reuse prior permits)',
        ),
      );

      const shape = await readPhase21Gen3AttemptShape(client, input.withdrawalId);
      attemptCount = shape.attemptCount;
      checks.push(
        check(
          'prior_attempts_exactly_two_failed_pre',
          shape.attemptCount === PHASE21_GEN3_REQUIRED_PRIOR_ATTEMPT_COUNT &&
            shape.failedPreAttemptCount === shape.attemptCount &&
            shape.attempt1FailedPre &&
            shape.attempt2FailedPre,
          'exactly attempt #1 and attempt #2 must exist and both be FAILED_PRE_BROADCAST',
          {
            expected: { attemptCount: 2, failedPre: 2 },
            actual: {
              attemptCount: shape.attemptCount,
              failedPre: shape.failedPreAttemptCount,
              attempt1FailedPre: shape.attempt1FailedPre,
              attempt2FailedPre: shape.attempt2FailedPre,
            },
          },
        ),
      );
      checks.push(
        check(
          'no_signature_or_broadcast_evidence',
          shape.evidenceCount === 0,
          'no BOC / signature / submit / chain reference on attempt #1 or #2 (signed-but-lost acceptable only when nothing persisted)',
          { actual: shape.evidenceCount },
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

  const hardFails = checks.filter((c) => c.status === 'FAIL');
  const ok = hardFails.length === 0;
  return {
    ok,
    mode: 'PLAN',
    withdrawalId: input.withdrawalId,
    publicId,
    authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
    readyForGen3Apply: ok,
    checks,
    gen1PermitStatus,
    gen1ConsumedAttemptId,
    gen2PermitStatus,
    gen2ConsumedAttemptId,
    gen2TemporalLaunchClaimPresent,
    gen3PermitStatus,
    attemptCount,
    reservationHeld,
    generalDispatchPausePreserved,
    broadcastPerformed: false,
    signed: false,
    mutated: false,
  };
}
