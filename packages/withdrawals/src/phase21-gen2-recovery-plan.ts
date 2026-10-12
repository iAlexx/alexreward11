/**
 * Phase 21 Generation-2 Owner-authorized recovery — PLAN (read-only).
 *
 * Proves a withdrawal is safe for a fresh Gen-2 one-shot permit after Gen-1
 * CONSUMED + FAILED_PRE attempt(s) with no durable BOC / broadcast evidence.
 * Never mutates DB, never arms permits, never signs, never broadcasts.
 *
 * Requires independent dual-provider chain reconciliation evidence supplied by
 * the caller (must be fresh — PLAN refuses stale / missing / non-HIGH confidence).
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
import { getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration } from './phase21-manual-dispatch-permit.js';

export const PHASE21_GEN2_RECOVERY_WITHDRAWAL_ID = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
export const PHASE21_GEN2_RECOVERY_PUBLIC_ID = PHASE21_CANARY_PAYOUT_PUBLIC_ID;
export const PHASE21_GEN2_AUTHORIZATION_GENERATION = 2 as const;

/** Max age for independent chain reconciliation evidence before PLAN/APPLY refuse. */
export const PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS = 15 * 60 * 1000;

export interface Phase21Gen2IndependentChainReconciliation {
  readonly performedAt: string;
  readonly primaryProviderKind: string;
  readonly secondaryProviderKind: string;
  readonly providersIndependent: true;
  readonly paymentObserved: false;
  readonly confidence: 'HIGH';
  readonly hotWalletAccountActive: boolean;
  readonly recipientUsdtTransferObserved: false;
  readonly detail: string;
}

export interface Phase21Gen2RecoveryPlanResult {
  readonly ok: boolean;
  readonly mode: 'PLAN';
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: number;
  readonly readyForGen2Apply: boolean;
  readonly checks: readonly Phase21CanaryPayoutCheck[];
  readonly gen1PermitStatus: string | null;
  readonly gen1ConsumedAttemptId: string | null;
  readonly gen2PermitStatus: string | null;
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

export function evaluatePhase21Gen2ChainReconciliationFreshness(
  evidence: Phase21Gen2IndependentChainReconciliation | null | undefined,
  nowMs: number = Date.now(),
): { readonly ok: boolean; readonly reason: string | null } {
  if (evidence == null) {
    return { ok: false, reason: 'chain_recon_missing' };
  }
  if (evidence.providersIndependent !== true) {
    return { ok: false, reason: 'providers_not_independent' };
  }
  if (evidence.paymentObserved !== false) {
    return { ok: false, reason: 'payment_observed' };
  }
  if (evidence.recipientUsdtTransferObserved !== false) {
    return { ok: false, reason: 'recipient_usdt_transfer_observed' };
  }
  if (evidence.confidence !== 'HIGH') {
    return { ok: false, reason: 'confidence_not_high' };
  }
  if (
    evidence.primaryProviderKind.trim() === '' ||
    evidence.secondaryProviderKind.trim() === '' ||
    evidence.primaryProviderKind === evidence.secondaryProviderKind
  ) {
    return { ok: false, reason: 'provider_kinds_invalid' };
  }
  const performed = Date.parse(evidence.performedAt);
  if (!Number.isFinite(performed)) {
    return { ok: false, reason: 'performed_at_invalid' };
  }
  const age = nowMs - performed;
  if (age < 0 || age > PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS) {
    return { ok: false, reason: 'chain_recon_stale_or_future' };
  }
  return { ok: true, reason: null };
}

/**
 * Pure eligibility helper for Gen-2 recovery after Gen-1 CONSUMED + FAILED_PRE.
 */
export function evaluatePhase21Gen2RecoveryEligibility(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string | null;
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
  if (input.gen2PermitStatus === 'CANCELLED') {
    return { eligible: false, reason: 'gen2_cancelled' };
  }
  if (input.attemptCount < 1) {
    return { eligible: false, reason: 'no_prior_attempt' };
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

export function mintPhase21Gen2IndependentChainReconciliationForTests(input?: {
  readonly performedAt?: string;
  readonly hotWalletAccountActive?: boolean;
  readonly detail?: string;
}): Phase21Gen2IndependentChainReconciliation {
  return {
    performedAt: input?.performedAt ?? new Date().toISOString(),
    primaryProviderKind: 'toncenter',
    secondaryProviderKind: 'tonapi',
    providersIndependent: true,
    paymentObserved: false,
    confidence: 'HIGH',
    hotWalletAccountActive: input?.hotWalletAccountActive ?? false,
    recipientUsdtTransferObserved: false,
    detail: input?.detail ?? 'test: dual-provider HIGH confidence no USDT payout observed',
  };
}

export async function planPhase21Gen2Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly chainReconciliation: Phase21Gen2IndependentChainReconciliation;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    /** Disposable E2E only — production APPLY never sets this. */
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen2RecoveryPlanResult> {
  const checks: Phase21CanaryPayoutCheck[] = [];
  const env = input.deploymentEnvironment ?? 'LOCAL';

  const canaryIdOk =
    input.withdrawalId === PHASE21_GEN2_RECOVERY_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  checks.push(
    check(
      'withdrawal_id_authorized',
      canaryIdOk,
      'Gen-2 PLAN hard-binds to Owner canary (or disposable test override)',
      { expected: PHASE21_GEN2_RECOVERY_WITHDRAWAL_ID, actual: input.withdrawalId },
    ),
  );

  const recon = evaluatePhase21Gen2ChainReconciliationFreshness(input.chainReconciliation);
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

  let publicId: string = PHASE21_GEN2_RECOVERY_PUBLIC_ID;
  let gen1PermitStatus: string | null = null;
  let gen1ConsumedAttemptId: string | null = null;
  let gen2PermitStatus: string | null = null;
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
        (row.public_id === PHASE21_GEN2_RECOVERY_PUBLIC_ID &&
          row.requested_amount_atomic ===
            PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10) &&
          row.fee_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10) &&
          row.net_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10) &&
          row.recipient_friendly === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY &&
          row.recipient_raw === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW &&
          row.network_code === PHASE21_NETWORK_CODE);
      checks.push(
        check('frozen_bindings', bindOk, 'amounts/recipient/network match Gen-2 frozen bindings'),
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
      const gen2Ok = gen2 === null || gen2.status === 'ARMED';
      checks.push(
        check(
          'gen2_absent_or_armed',
          gen2Ok,
          'Gen-2 must be absent (fresh) or already ARMED (idempotent)',
          { actual: gen2PermitStatus },
        ),
      );

      const attempts = await client.query<{
        c: number;
        failed_pre: number;
        evidence: number;
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
                     OR (chain_reference IS NOT NULL AND btrim(chain_reference) <> '')
                )::int AS evidence
         FROM withdrawal_attempts
         WHERE withdrawal_id = $1::uuid`,
        [input.withdrawalId],
      );
      attemptCount = attempts.rows[0]?.c ?? 0;
      const failedPre = attempts.rows[0]?.failed_pre ?? 0;
      const evidence = attempts.rows[0]?.evidence ?? 0;
      checks.push(
        check(
          'prior_attempts_failed_pre_only',
          attemptCount >= 1 && failedPre === attemptCount,
          'all prior attempts must be FAILED_PRE_BROADCAST',
          { expected: 'all FAILED_PRE', actual: { attemptCount, failedPre } },
        ),
      );
      checks.push(
        check(
          'no_signature_or_broadcast_evidence',
          evidence === 0,
          'no BOC / signature / submit / chain reference on any attempt',
          { actual: evidence },
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
    authorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
    readyForGen2Apply: ok,
    checks,
    gen1PermitStatus,
    gen1ConsumedAttemptId,
    gen2PermitStatus,
    attemptCount,
    reservationHeld,
    generalDispatchPausePreserved,
    broadcastPerformed: false,
    signed: false,
    mutated: false,
  };
}
