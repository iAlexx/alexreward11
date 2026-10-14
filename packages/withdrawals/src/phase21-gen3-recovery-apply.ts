/**
 * Phase 21 Generation-3 Owner-authorized recovery — APPLY.
 *
 * Arms a fresh Gen-3 one-shot manual dispatch permit only.
 * NEVER signs, NEVER broadcasts, NEVER unlocks signer, NEVER globally unpauses,
 * NEVER enables the outbox relay.
 * Preserves Gen-1 CONSUMED + attempt #1 and Gen-2 CONSUMED + attempt #2 permanently,
 * and preserves the durable Gen-2 Temporal launch claim.
 * Reuses the existing withdrawal reservation (no double debit / settle).
 *
 * Requires: branded Owner trust + Gen-3 confirmation + fresh independent chain recon
 * + PLAN soft precheck + FOR UPDATE revalidation inside one mutation transaction.
 */
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  assertPhase21Gen3RecoveryApplyConfirmation,
  type Phase21Gen3RecoveryApplyConfirmation,
} from './phase21-ceremony-confirmations.js';
import {
  PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS,
} from './phase21-canary-payout-apply.js';
import { PHASE21_GEN2_AUTHORIZATION_GENERATION } from './phase21-gen2-recovery-plan.js';
import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  evaluatePhase21Gen3ChainReconciliationFreshness,
  isPhase21Gen3AttemptShapeAccepted,
  planPhase21Gen3Recovery,
  readPhase21Gen2TemporalLaunchClaimPresent,
  readPhase21Gen3AttemptShape,
  type Phase21Gen3IndependentChainReconciliation,
  type Phase21Gen3RecoveryPlanResult,
} from './phase21-gen3-recovery-plan.js';
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

export const PHASE21_GEN3_RECOVERY_APPLY_ENABLED = true as const;

export interface Phase21Gen3RecoveryApplyResult {
  readonly ok: boolean;
  readonly mode: 'APPLY';
  readonly applied: boolean;
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: typeof PHASE21_GEN3_AUTHORIZATION_GENERATION;
  readonly permitId: string | null;
  readonly permitStatus: Phase21ManualDispatchPermitRow['status'] | null;
  readonly gen1PermitId: string | null;
  readonly gen1PermitStatus: string | null;
  readonly gen2PermitId: string | null;
  readonly gen2PermitStatus: string | null;
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
  readonly outboxRelayStillDisabled: true;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly readyForLivePayout: false;
  readonly reservationReused: true;
  readonly nextOperationalState: string;
  readonly refuseCode?: string;
  readonly message?: string;
  readonly planChecksFailed?: ReadonlyArray<string>;
  readonly plan?: Phase21Gen3RecoveryPlanResult;
}

type FixedApplyFields =
  | 'ok'
  | 'mode'
  | 'applied'
  | 'broadcastPerformed'
  | 'signed'
  | 'readyForLivePayout'
  | 'generalDispatchPausePreserved'
  | 'generalWithdrawalIntakePreserved'
  | 'autoPayoutStillDisabled'
  | 'outboxRelayStillDisabled'
  | 'reservationReused'
  | 'authorizationGeneration';

function refuseApply(
  partial: Omit<Phase21Gen3RecoveryApplyResult, FixedApplyFields>,
): Phase21Gen3RecoveryApplyResult {
  return {
    ok: false,
    mode: 'APPLY',
    applied: false,
    authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
    broadcastPerformed: false,
    signed: false,
    readyForLivePayout: false,
    generalDispatchPausePreserved: true,
    generalWithdrawalIntakePreserved: true,
    autoPayoutStillDisabled: true,
    outboxRelayStillDisabled: true,
    reservationReused: true,
    ...partial,
  };
}

function emptyRefuseFields(withdrawalId: string): Omit<
  Phase21Gen3RecoveryApplyResult,
  | FixedApplyFields
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
    gen2PermitId: null,
    gen2PermitStatus: null,
    created: false,
    reused: false,
    workflowId: withdrawalWorkflowId(withdrawalId),
    outboxEventId: null,
    outboxCreated: false,
    outboxExisting: false,
    outboxEnqueued: false,
  };
}

async function revalidateGen3MutablePreconditions(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  withdrawalId: string,
  bindings: Phase21ManualDispatchPermitBindings,
  allowNonCanary: boolean,
  deploymentEnvironment: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION',
): Promise<{ ok: true } | { ok: false; reason: string; failed: string[] }> {
  const failed: string[] = [];

  // Exact-environment pause only: a paused LOCAL/STAGING flag must never satisfy an
  // unpaused PRODUCTION (or other) ceremony. Re-check under the mutation lock so a
  // concurrent unpause of the target environment cannot race past PLAN.
  const paused = await isPayoutDispatchPaused(client, deploymentEnvironment);
  if (paused !== true) {
    failed.push('payout_dispatch_pause');
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

  const gen2 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
    client,
    withdrawalId,
    PHASE21_GEN2_AUTHORIZATION_GENERATION,
  );
  if (gen2 === null || gen2.status !== 'CONSUMED' || gen2.consumedAttemptId === null) {
    failed.push('gen2_consumed');
  } else {
    const gen2ClaimPresent = await readPhase21Gen2TemporalLaunchClaimPresent(client, {
      withdrawalId,
      gen2PermitId: gen2.id,
    });
    if (!gen2ClaimPresent) failed.push('gen2_temporal_launch_claim_preserved');
  }
  if (
    gen1 !== null &&
    gen2 !== null &&
    gen1.consumedAttemptId !== null &&
    gen1.consumedAttemptId === gen2.consumedAttemptId
  ) {
    failed.push('gen2_bound_attempt_differs_from_gen1');
  }

  const shape = await readPhase21Gen3AttemptShape(client, withdrawalId);
  if (!isPhase21Gen3AttemptShapeAccepted(shape)) {
    if (shape.attemptCount !== 2 || shape.failedPreAttemptCount !== shape.attemptCount) {
      failed.push('exactly_two_failed_pre');
    }
    if (!shape.attempt1FailedPre || !shape.attempt2FailedPre) failed.push('attempt_numbers_1_and_2');
    if (shape.evidenceCount !== 0) failed.push('no_evidence');
  }

  if (failed.length > 0) {
    return {
      ok: false,
      reason: 'Gen-3 mutable preconditions failed under FOR UPDATE lock',
      failed,
    };
  }
  return { ok: true };
}

/**
 * APPLY: Owner confirmation + fresh chain recon + PLAN soft precheck, then one
 * mutation transaction: FOR UPDATE revalidation + arm Gen-3 permit + audit + outbox.
 *
 * The PENDING manual_dispatch outbox row is enqueued for parity with Gen-2, but the
 * global relay stays OFF; the Owner Gen-3 Temporal one-shot claim is the launch path.
 */
export async function applyPhase21Gen3Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly ownerTrust: AuthenticatedPhase21OwnerCeremonyTrust;
    readonly applyConfirmation: Phase21Gen3RecoveryApplyConfirmation;
    readonly chainReconciliation: Phase21Gen3IndependentChainReconciliation;
    readonly bindings?: Phase21ManualDispatchPermitBindings;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen3RecoveryApplyResult> {
  if (PHASE21_GEN3_RECOVERY_APPLY_ENABLED !== true) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'APPLY_DISABLED',
      refuseCode: 'PHASE21_GEN3_RECOVERY_APPLY_NOT_ENABLED',
      message: 'Phase 21 Gen-3 recovery APPLY is not enabled',
    });
  }

  assertAuthenticatedPhase21OwnerCeremonyTrust(input.ownerTrust);
  assertPhase21Gen3RecoveryApplyConfirmation(input.applyConfirmation);

  const allowNonCanary = input.allowNonCanaryWithdrawalIdForTests === true;
  if (
    !allowNonCanary &&
    input.withdrawalId !== PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.withdrawalId
  ) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_WRONG_WITHDRAWAL',
      refuseCode: 'GEN3_WITHDRAWAL_ID_MISMATCH',
      message: 'Gen-3 APPLY hard-binds to the sole Owner-authorized canary withdrawal',
    });
  }

  const recon = evaluatePhase21Gen3ChainReconciliationFreshness(input.chainReconciliation);
  if (!recon.ok) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_CHAIN_RECON',
      refuseCode: 'GEN3_CHAIN_RECON_REQUIRED',
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
      refuseCode: 'GEN3_BINDINGS_WITHDRAWAL_MISMATCH',
      message: 'bindings.withdrawalId must equal APPLY withdrawalId',
    });
  }

  const deploymentEnvironment = input.deploymentEnvironment ?? 'LOCAL';

  const plan = await planPhase21Gen3Recovery(client, {
    withdrawalId: input.withdrawalId,
    chainReconciliation: input.chainReconciliation,
    deploymentEnvironment,
    allowNonCanaryWithdrawalIdForTests: allowNonCanary,
  });
  const hardFails = plan.checks.filter((c) => c.status === 'FAIL');
  if (hardFails.length > 0) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_PRECONDITIONS',
      refuseCode: 'GEN3_APPLY_PRECONDITIONS_FAILED',
      message: 'Gen-3 APPLY refused: PLAN FAIL checks present',
      planChecksFailed: hardFails.map((c) => c.id),
      plan,
    });
  }

  await client.query('BEGIN');
  try {
    const revalidated = await revalidateGen3MutablePreconditions(
      client,
      input.withdrawalId,
      bindings,
      allowNonCanary,
      deploymentEnvironment,
    );
    if (!revalidated.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_REVALIDATION',
        refuseCode: 'GEN3_APPLY_REVALIDATION_FAILED',
        message: revalidated.reason,
        planChecksFailed: revalidated.failed,
        plan,
      });
    }

    // Fresh chain recon must still be valid at mutation time.
    const reconAgain = evaluatePhase21Gen3ChainReconciliationFreshness(input.chainReconciliation);
    if (!reconAgain.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_CHAIN_RECON',
        refuseCode: 'GEN3_CHAIN_RECON_STALE_AT_MUTATION',
        message: reconAgain.reason ?? 'chain recon stale',
        plan,
      });
    }

    const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
      client,
      input.withdrawalId,
      1,
    );
    const gen2 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
      client,
      input.withdrawalId,
      PHASE21_GEN2_AUTHORIZATION_GENERATION,
    );

    const armed = await armPhase21ManualDispatchPermitGeneration(client, {
      bindings,
      authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
      createdByAdminUserId: input.ownerTrust.adminUserId,
      idempotencyKey: phase21ManualDispatchGenerationIdempotencyKey(
        bindings.withdrawalId,
        PHASE21_GEN3_AUTHORIZATION_GENERATION,
      ),
      auditCorrelationId: `phase21-gen3-recovery-apply:${bindings.withdrawalId}`,
    });

    if (
      (gen1 !== null && armed.permit.id === gen1.id) ||
      (gen2 !== null && armed.permit.id === gen2.id)
    ) {
      // Defensive: generation-unique index makes this unreachable; fail closed anyway.
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_PRIOR_PERMIT_REUSE',
        refuseCode: 'GEN3_PRIOR_PERMIT_REUSE_REFUSED',
        message: 'Gen-3 permit id collided with a prior generation permit',
        plan,
      });
    }

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
      authorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
      permitId: armed.permit.id,
      permitStatus: armed.permit.status,
      gen1PermitId: gen1?.id ?? null,
      gen1PermitStatus: gen1?.status ?? null,
      gen2PermitId: gen2?.id ?? null,
      gen2PermitStatus: gen2?.status ?? null,
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
      outboxRelayStillDisabled: true,
      broadcastPerformed: false,
      signed: false,
      readyForLivePayout: false,
      reservationReused: true,
      nextOperationalState:
        'GEN3_PERMIT_ARMED — Owner Gen-3 Temporal one-shot claim starts withdrawal/{id} with ALLOW_DUPLICATE; ' +
        'canonical pipeline creates attempt #3, consumes Gen-3 permit; Gen-1 + Gen-2 CONSUMED preserved; ' +
        'relay stays OFF; Owner unlocks signer only during signing window; reconcile before any resend',
      message: armed.reused
        ? 'idempotent Gen-3 APPLY: existing Gen-3 permit reused; no broadcast'
        : 'Phase 21 Gen-3 recovery permit armed; no broadcast; canonical pipeline must execute',
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
      error instanceof WithdrawalDomainError ? error.code : 'GEN3_APPLY_MUTATION_FAILED';
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_MUTATION_ROLLBACK',
      refuseCode: code,
      message,
      plan,
    });
  }
}
