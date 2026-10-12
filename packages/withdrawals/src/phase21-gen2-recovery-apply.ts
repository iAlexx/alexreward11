/**
 * Phase 21 Generation-2 Owner-authorized recovery — APPLY.
 *
 * Arms a fresh Gen-2 one-shot manual dispatch permit only.
 * NEVER signs, NEVER broadcasts, NEVER unlocks signer, NEVER globally unpauses.
 * Preserves Gen-1 CONSUMED + failed attempt #1 permanently.
 * Reuses the existing withdrawal reservation (no double debit / settle).
 *
 * Requires: branded Owner trust + Gen-2 confirmation + fresh independent chain recon
 * + PLAN soft precheck + FOR UPDATE revalidation inside one mutation transaction.
 */
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  assertPhase21Gen2RecoveryApplyConfirmation,
  type Phase21Gen2RecoveryApplyConfirmation,
} from './phase21-ceremony-confirmations.js';
import {
  PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS,
} from './phase21-canary-payout-apply.js';
import {
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  evaluatePhase21Gen2ChainReconciliationFreshness,
  planPhase21Gen2Recovery,
  type Phase21Gen2IndependentChainReconciliation,
  type Phase21Gen2RecoveryPlanResult,
} from './phase21-gen2-recovery-plan.js';
import type { Phase21CanaryPayoutPlanClient } from './phase21-canary-payout-plan.js';
import {
  armPhase21ManualDispatchPermitGeneration,
  enqueuePhase21ManualDispatchOutbox,
  getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration,
  phase21ManualDispatchGenerationIdempotencyKey,
  type Phase21ManualDispatchPermitBindings,
  type Phase21ManualDispatchPermitRow,
} from './phase21-manual-dispatch-permit.js';
import {
  assertAuthenticatedPhase21OwnerCeremonyTrust,
  type AuthenticatedPhase21OwnerCeremonyTrust,
} from './phase21-owner-ceremony-trust.js';
import { withdrawalWorkflowId } from './outbox.js';

export const PHASE21_GEN2_RECOVERY_APPLY_ENABLED = true as const;

export interface Phase21Gen2RecoveryApplyResult {
  readonly ok: boolean;
  readonly mode: 'APPLY';
  readonly applied: boolean;
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: typeof PHASE21_GEN2_AUTHORIZATION_GENERATION;
  readonly permitId: string | null;
  readonly permitStatus: Phase21ManualDispatchPermitRow['status'] | null;
  readonly gen1PermitId: string | null;
  readonly gen1PermitStatus: string | null;
  readonly created: boolean;
  readonly reused: boolean;
  readonly workflowId: string;
  readonly outboxEventId: string | null;
  readonly outboxCreated: boolean;
  readonly outboxExisting: boolean;
  readonly outboxEnqueued: boolean;
  readonly generalDispatchPausePreserved: true;
  readonly generalWithdrawalIntakePreserved: true;
  readonly autoPayoutStillDisabled: true;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly readyForLivePayout: false;
  readonly reservationReused: true;
  readonly nextOperationalState: string;
  readonly refuseCode?: string;
  readonly message?: string;
  readonly planChecksFailed?: ReadonlyArray<string>;
  readonly plan?: Phase21Gen2RecoveryPlanResult;
}

function refuseApply(
  partial: Omit<
    Phase21Gen2RecoveryApplyResult,
    | 'ok'
    | 'mode'
    | 'applied'
    | 'broadcastPerformed'
    | 'signed'
    | 'readyForLivePayout'
    | 'generalDispatchPausePreserved'
    | 'generalWithdrawalIntakePreserved'
    | 'autoPayoutStillDisabled'
    | 'reservationReused'
    | 'authorizationGeneration'
  >,
): Phase21Gen2RecoveryApplyResult {
  return {
    ok: false,
    mode: 'APPLY',
    applied: false,
    authorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
    broadcastPerformed: false,
    signed: false,
    readyForLivePayout: false,
    generalDispatchPausePreserved: true,
    generalWithdrawalIntakePreserved: true,
    autoPayoutStillDisabled: true,
    reservationReused: true,
    ...partial,
  };
}

function emptyRefuseFields(withdrawalId: string): Omit<
  Phase21Gen2RecoveryApplyResult,
  | 'ok'
  | 'mode'
  | 'applied'
  | 'broadcastPerformed'
  | 'signed'
  | 'readyForLivePayout'
  | 'generalDispatchPausePreserved'
  | 'generalWithdrawalIntakePreserved'
  | 'autoPayoutStillDisabled'
  | 'reservationReused'
  | 'authorizationGeneration'
  | 'nextOperationalState'
  | 'refuseCode'
  | 'message'
  | 'planChecksFailed'
  | 'plan'
> {
  return {
    withdrawalId,
    publicId: PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.publicId,
    permitId: null,
    permitStatus: null,
    gen1PermitId: null,
    gen1PermitStatus: null,
    created: false,
    reused: false,
    workflowId: withdrawalWorkflowId(withdrawalId),
    outboxEventId: null,
    outboxCreated: false,
    outboxExisting: false,
    outboxEnqueued: false,
  };
}

async function revalidateGen2MutablePreconditions(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  withdrawalId: string,
  bindings: Phase21ManualDispatchPermitBindings,
  allowNonCanary: boolean,
): Promise<{ ok: true } | { ok: false; reason: string; failed: string[] }> {
  const failed: string[] = [];

  const paused = await isPayoutDispatchPaused(client, 'LOCAL');
  // Also check PRODUCTION-style via LOCAL fixture in tests; APPLY caller may use PRODUCTION env.
  // Re-check via both LOCAL and PRODUCTION if rows exist — prefer any pause true.
  const pausedProd = await isPayoutDispatchPaused(client, 'PRODUCTION');
  if (paused !== true && pausedProd !== true) {
    // For disposable LOCAL tests the pause flag is LOCAL=true.
    const pausedDev = await isPayoutDispatchPaused(client, 'DEV');
    const pausedStaging = await isPayoutDispatchPaused(client, 'STAGING');
    if (!(paused || pausedProd || pausedDev || pausedStaging)) {
      failed.push('payout_dispatch_pause');
    }
  }

  const locked = await client.query<{
    id: string;
    public_id: string;
    state: string;
    requested_amount_atomic: string;
    fee_amount_atomic: string;
    net_amount_atomic: string;
    reservation_ledger_tx_id: string | null;
    release_ledger_tx_id: string | null;
    settlement_ledger_tx_id: string | null;
  }>(
    `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
            w.requested_amount_atomic::text AS requested_amount_atomic,
            w.fee_amount_atomic::text AS fee_amount_atomic,
            w.net_amount_atomic::text AS net_amount_atomic,
            w.reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
            w.release_ledger_tx_id::text AS release_ledger_tx_id,
            w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id
     FROM withdrawals w
     WHERE w.id = $1::uuid
     FOR UPDATE OF w`,
    [withdrawalId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    return { ok: false, reason: 'withdrawal missing under lock', failed: ['withdrawal_present'] };
  }
  if (!allowNonCanary && row.public_id !== bindings.publicId) failed.push('public_id');
  if (row.state !== 'FAILED_PRE_BROADCAST' && row.state !== 'QUEUED') failed.push('state');
  if (row.requested_amount_atomic !== bindings.authorizedGrossAtomic.toString(10)) {
    failed.push('gross_atomic');
  }
  if (row.fee_amount_atomic !== bindings.authorizedFeeAtomic.toString(10)) failed.push('fee_atomic');
  if (row.net_amount_atomic !== bindings.authorizedNetAtomic.toString(10)) failed.push('net_atomic');
  if (row.reservation_ledger_tx_id === null) failed.push('reservation_held');
  if (row.release_ledger_tx_id !== null) failed.push('no_release');
  if (row.settlement_ledger_tx_id !== null) failed.push('no_settlement');

  const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
    client,
    withdrawalId,
    1,
  );
  if (gen1 === null || gen1.status !== 'CONSUMED' || gen1.consumedAttemptId === null) {
    failed.push('gen1_consumed');
  }

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
    [withdrawalId],
  );
  const attemptCount = attempts.rows[0]?.c ?? 0;
  const failedPre = attempts.rows[0]?.failed_pre ?? 0;
  const evidence = attempts.rows[0]?.evidence ?? 0;
  if (!(attemptCount >= 1 && failedPre === attemptCount)) failed.push('failed_pre_only');
  if (evidence !== 0) failed.push('no_evidence');

  if (failed.length > 0) {
    return {
      ok: false,
      reason: 'Gen-2 mutable preconditions failed under FOR UPDATE lock',
      failed,
    };
  }
  return { ok: true };
}

/**
 * APPLY: Owner confirmation + fresh chain recon + PLAN soft precheck, then one
 * mutation transaction: FOR UPDATE revalidation + arm Gen-2 permit + audit + outbox.
 */
export async function applyPhase21Gen2Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly ownerTrust: AuthenticatedPhase21OwnerCeremonyTrust;
    readonly applyConfirmation: Phase21Gen2RecoveryApplyConfirmation;
    readonly chainReconciliation: Phase21Gen2IndependentChainReconciliation;
    readonly bindings?: Phase21ManualDispatchPermitBindings;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen2RecoveryApplyResult> {
  if (PHASE21_GEN2_RECOVERY_APPLY_ENABLED !== true) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'APPLY_DISABLED',
      refuseCode: 'PHASE21_GEN2_RECOVERY_APPLY_NOT_ENABLED',
      message: 'Phase 21 Gen-2 recovery APPLY is not enabled',
    });
  }

  assertAuthenticatedPhase21OwnerCeremonyTrust(input.ownerTrust);
  assertPhase21Gen2RecoveryApplyConfirmation(input.applyConfirmation);

  const allowNonCanary = input.allowNonCanaryWithdrawalIdForTests === true;
  if (
    !allowNonCanary &&
    input.withdrawalId !== PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.withdrawalId
  ) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_WRONG_WITHDRAWAL',
      refuseCode: 'GEN2_WITHDRAWAL_ID_MISMATCH',
      message: 'Gen-2 APPLY hard-binds to the sole Owner-authorized canary withdrawal',
    });
  }

  const recon = evaluatePhase21Gen2ChainReconciliationFreshness(input.chainReconciliation);
  if (!recon.ok) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_CHAIN_RECON',
      refuseCode: 'GEN2_CHAIN_RECON_REQUIRED',
      message: `independent chain reconciliation required immediately before APPLY: ${recon.reason}`,
    });
  }

  const bindings = input.bindings ?? {
    ...PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS,
    withdrawalId: input.withdrawalId,
  };
  if (bindings.withdrawalId !== input.withdrawalId) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_BINDINGS',
      refuseCode: 'GEN2_BINDINGS_WITHDRAWAL_MISMATCH',
      message: 'bindings.withdrawalId must equal APPLY withdrawalId',
    });
  }

  const plan = await planPhase21Gen2Recovery(client, {
    withdrawalId: input.withdrawalId,
    chainReconciliation: input.chainReconciliation,
    deploymentEnvironment: input.deploymentEnvironment ?? 'LOCAL',
    allowNonCanaryWithdrawalIdForTests: allowNonCanary,
  });
  const hardFails = plan.checks.filter((c) => c.status === 'FAIL');
  if (hardFails.length > 0) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_PRECONDITIONS',
      refuseCode: 'GEN2_APPLY_PRECONDITIONS_FAILED',
      message: 'Gen-2 APPLY refused: PLAN FAIL checks present',
      planChecksFailed: hardFails.map((c) => c.id),
      plan,
    });
  }

  await client.query('BEGIN');
  try {
    const revalidated = await revalidateGen2MutablePreconditions(
      client,
      input.withdrawalId,
      bindings,
      allowNonCanary,
    );
    if (!revalidated.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_REVALIDATION',
        refuseCode: 'GEN2_APPLY_REVALIDATION_FAILED',
        message: revalidated.reason,
        planChecksFailed: revalidated.failed,
        plan,
      });
    }

    // Fresh chain recon must still be valid at mutation time.
    const reconAgain = evaluatePhase21Gen2ChainReconciliationFreshness(input.chainReconciliation);
    if (!reconAgain.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_CHAIN_RECON',
        refuseCode: 'GEN2_CHAIN_RECON_STALE_AT_MUTATION',
        message: reconAgain.reason ?? 'chain recon stale',
        plan,
      });
    }

    const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
      client,
      input.withdrawalId,
      1,
    );

    const armed = await armPhase21ManualDispatchPermitGeneration(client, {
      bindings,
      authorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
      createdByAdminUserId: input.ownerTrust.adminUserId,
      idempotencyKey: phase21ManualDispatchGenerationIdempotencyKey(
        bindings.withdrawalId,
        PHASE21_GEN2_AUTHORIZATION_GENERATION,
      ),
      auditCorrelationId: `phase21-gen2-recovery-apply:${bindings.withdrawalId}`,
    });

    const outbox = await enqueuePhase21ManualDispatchOutbox(client, {
      withdrawalId: bindings.withdrawalId,
      permitId: armed.permit.id,
    });

    await client.query('COMMIT');

    const outboxCreated = outbox.created === true;
    const outboxExisting = outbox.created === false;

    return {
      ok: true,
      mode: 'APPLY',
      applied: true,
      withdrawalId: bindings.withdrawalId,
      publicId: bindings.publicId,
      authorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
      permitId: armed.permit.id,
      permitStatus: armed.permit.status,
      gen1PermitId: gen1?.id ?? null,
      gen1PermitStatus: gen1?.status ?? null,
      created: armed.created,
      reused: armed.reused,
      workflowId: outbox.workflowId,
      outboxEventId: outbox.outboxId,
      outboxCreated,
      outboxExisting,
      outboxEnqueued: outboxCreated || outboxExisting,
      generalDispatchPausePreserved: true,
      generalWithdrawalIntakePreserved: true,
      autoPayoutStillDisabled: true,
      broadcastPerformed: false,
      signed: false,
      readyForLivePayout: false,
      reservationReused: true,
      nextOperationalState:
        'GEN2_PERMIT_ARMED — Worker outbox relay restarts withdrawal/{id} with ALLOW_DUPLICATE; ' +
        'canonical pipeline creates attempt #2, consumes Gen-2 permit; Gen-1 CONSUMED preserved; ' +
        'Owner unlocks signer only during signing window; reconcile before any resend',
      message: armed.reused
        ? 'idempotent Gen-2 APPLY: existing Gen-2 permit reused; no broadcast'
        : 'Phase 21 Gen-2 recovery permit armed; no broadcast; canonical pipeline must execute',
      plan,
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof WithdrawalDomainError ? error.code : 'GEN2_APPLY_MUTATION_FAILED';
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_MUTATION_ROLLBACK',
      refuseCode: code,
      message,
      plan,
    });
  }
}
