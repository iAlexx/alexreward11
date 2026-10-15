/**
 * Phase 21 Generation-4 Owner-authorized recovery — APPLY.
 *
 * Arms a fresh Gen-4 one-shot manual dispatch permit only.
 * NEVER signs, NEVER broadcasts, NEVER unlocks signer, NEVER globally unpauses,
 * NEVER enables the outbox relay, NEVER starts Temporal.
 * Preserves Gen-1 CONSUMED + attempt #1, Gen-2 CONSUMED + attempt #2, Gen-3 CONSUMED +
 * attempt #3 permanently, and preserves the durable Gen-2 AND Gen-3 Temporal launch claims.
 * Reuses the existing withdrawal reservation (no double debit / settle).
 *
 * Requires: branded Owner trust + Gen-4 confirmation + fresh independent chain recon
 * (bound to canary wallets + the three prior query_ids) + PLAN soft precheck + FOR UPDATE
 * revalidation (including attempt-shape and Gen-3 launch-claim binding) inside one
 * mutation transaction.
 */
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  assertPhase21Gen4RecoveryApplyConfirmation,
  type Phase21Gen4RecoveryApplyConfirmation,
} from './phase21-ceremony-confirmations.js';
import { PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS } from './phase21-canary-payout-apply.js';
import { PHASE21_GEN2_AUTHORIZATION_GENERATION } from './phase21-gen2-recovery-plan.js';
import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  readPhase21Gen2TemporalLaunchClaimPresent,
} from './phase21-gen3-recovery-plan.js';
import { verifyPhase21Gen3TemporalLaunchClaimBinding } from './phase21-gen3-temporal-launch.js';
import {
  PHASE21_GEN4_AUTHORIZATION_GENERATION,
  PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT,
  evaluatePhase21Gen4ChainReconciliationFreshness,
  isPhase21Gen4AttemptShapeAccepted,
  lockPhase21Gen4AttemptRowsAndReadQueryIds,
  planPhase21Gen4Recovery,
  readPhase21Gen4AttemptShape,
  verifyPhase21Gen4ExactPermitAttemptBindings,
  type Phase21Gen4IndependentChainReconciliation,
  type Phase21Gen4RecoveryPlanResult,
} from './phase21-gen4-recovery-plan.js';
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

export const PHASE21_GEN4_RECOVERY_APPLY_ENABLED = true as const;

export interface Phase21Gen4RecoveryApplyResult {
  readonly ok: boolean;
  readonly mode: 'APPLY';
  readonly applied: boolean;
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: typeof PHASE21_GEN4_AUTHORIZATION_GENERATION;
  readonly permitId: string | null;
  readonly permitStatus: Phase21ManualDispatchPermitRow['status'] | null;
  readonly gen1PermitId: string | null;
  readonly gen1PermitStatus: string | null;
  readonly gen2PermitId: string | null;
  readonly gen2PermitStatus: string | null;
  readonly gen3PermitId: string | null;
  readonly gen3PermitStatus: string | null;
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
  readonly temporalStarted: false;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly readyForLivePayout: false;
  readonly reservationReused: true;
  readonly nextOperationalState: string;
  readonly refuseCode?: string;
  readonly message?: string;
  readonly planChecksFailed?: ReadonlyArray<string>;
  readonly plan?: Phase21Gen4RecoveryPlanResult;
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
  | 'temporalStarted'
  | 'reservationReused'
  | 'authorizationGeneration';

function refuseApply(
  partial: Omit<Phase21Gen4RecoveryApplyResult, FixedApplyFields>,
): Phase21Gen4RecoveryApplyResult {
  return {
    ok: false,
    mode: 'APPLY',
    applied: false,
    authorizationGeneration: PHASE21_GEN4_AUTHORIZATION_GENERATION,
    broadcastPerformed: false,
    signed: false,
    readyForLivePayout: false,
    generalDispatchPausePreserved: true,
    generalWithdrawalIntakePreserved: true,
    autoPayoutStillDisabled: true,
    outboxRelayStillDisabled: true,
    temporalStarted: false,
    reservationReused: true,
    ...partial,
  };
}

function emptyRefuseFields(withdrawalId: string): Omit<
  Phase21Gen4RecoveryApplyResult,
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
    gen3PermitId: null,
    gen3PermitStatus: null,
    created: false,
    reused: false,
    workflowId: withdrawalWorkflowId(withdrawalId),
    outboxEventId: null,
    outboxCreated: false,
    outboxExisting: false,
    outboxEnqueued: false,
  };
}

async function revalidateGen4MutablePreconditions(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  withdrawalId: string,
  bindings: Phase21ManualDispatchPermitBindings,
  allowNonCanary: boolean,
  deploymentEnvironment: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION',
  chainReconciliation: Phase21Gen4IndependentChainReconciliation,
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

  const gen3 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
    client,
    withdrawalId,
    PHASE21_GEN3_AUTHORIZATION_GENERATION,
  );
  if (gen3 === null || gen3.status !== 'CONSUMED' || gen3.consumedAttemptId === null) {
    failed.push('gen3_consumed');
  } else {
    // Mere claim presence is insufficient: payload + permit + attempt #3 binding.
    const binding = await verifyPhase21Gen3TemporalLaunchClaimBinding(client, { withdrawalId });
    if (!binding.ok) failed.push('gen3_temporal_launch_claim_bound');
  }

  if (
    gen1 !== null &&
    gen2 !== null &&
    gen1.consumedAttemptId !== null &&
    gen1.consumedAttemptId === gen2.consumedAttemptId
  ) {
    failed.push('gen2_bound_attempt_differs_from_gen1');
  }
  if (
    gen3 !== null &&
    gen3.consumedAttemptId !== null &&
    ((gen1 !== null && gen1.consumedAttemptId === gen3.consumedAttemptId) ||
      (gen2 !== null && gen2.consumedAttemptId === gen3.consumedAttemptId))
  ) {
    failed.push('gen3_bound_attempt_distinct');
  }

  // Attempt rows locked FOR UPDATE first; shape + query ids are read under those locks.
  const lockedQueryIds = await lockPhase21Gen4AttemptRowsAndReadQueryIds(client, withdrawalId);

  // Exact permit→attempt_number bindings, verified under the attempt row locks.
  if (
    gen1?.consumedAttemptId != null &&
    gen2?.consumedAttemptId != null &&
    gen3?.consumedAttemptId != null
  ) {
    const exact = await verifyPhase21Gen4ExactPermitAttemptBindings(client, {
      withdrawalId,
      gen1ConsumedAttemptId: gen1.consumedAttemptId,
      gen2ConsumedAttemptId: gen2.consumedAttemptId,
      gen3ConsumedAttemptId: gen3.consumedAttemptId,
    });
    if (!exact.ok) failed.push(exact.reason);
  } else {
    failed.push('attempt_rows_incomplete');
  }

  const shape = await readPhase21Gen4AttemptShape(client, withdrawalId);
  if (!isPhase21Gen4AttemptShapeAccepted(shape)) {
    if (
      shape.attemptCount !== PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT ||
      shape.failedPreAttemptCount !== shape.attemptCount
    ) {
      failed.push('exactly_three_failed_pre');
    }
    if (!shape.attempt1FailedPre || !shape.attempt2FailedPre || !shape.attempt3FailedPre) {
      failed.push('attempt_numbers_1_2_and_3');
    }
    if (shape.evidenceCount !== 0) failed.push('no_evidence');
  }

  const reconBound = evaluatePhase21Gen4ChainReconciliationFreshness(
    chainReconciliation,
    Date.now(),
    { expectedPriorQueryIds: lockedQueryIds },
  );
  if (!reconBound.ok) failed.push('chain_recon_' + String(reconBound.reason));

  if (failed.length > 0) {
    return {
      ok: false,
      reason: 'Gen-4 mutable preconditions failed under FOR UPDATE lock',
      failed,
    };
  }
  return { ok: true };
}

/**
 * APPLY: Owner confirmation + fresh chain recon + PLAN soft precheck, then one
 * mutation transaction: FOR UPDATE revalidation + arm Gen-4 permit + audit + outbox.
 *
 * The PENDING manual_dispatch outbox row is enqueued for parity with Gen-2/3, but the
 * global relay stays OFF (and the relay refuses Gen>=3 audit-only rows even if enabled);
 * the Owner Gen-4 Temporal one-shot claim is the launch path. APPLY never starts Temporal.
 */
export async function applyPhase21Gen4Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly ownerTrust: AuthenticatedPhase21OwnerCeremonyTrust;
    readonly applyConfirmation: Phase21Gen4RecoveryApplyConfirmation;
    readonly chainReconciliation: Phase21Gen4IndependentChainReconciliation;
    readonly bindings?: Phase21ManualDispatchPermitBindings;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen4RecoveryApplyResult> {
  if (PHASE21_GEN4_RECOVERY_APPLY_ENABLED !== true) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'APPLY_DISABLED',
      refuseCode: 'PHASE21_GEN4_RECOVERY_APPLY_NOT_ENABLED',
      message: 'Phase 21 Gen-4 recovery APPLY is not enabled',
    });
  }

  assertAuthenticatedPhase21OwnerCeremonyTrust(input.ownerTrust);
  assertPhase21Gen4RecoveryApplyConfirmation(input.applyConfirmation);

  const allowNonCanary = input.allowNonCanaryWithdrawalIdForTests === true;
  if (
    !allowNonCanary &&
    input.withdrawalId !== PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.withdrawalId
  ) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_WRONG_WITHDRAWAL',
      refuseCode: 'GEN4_WITHDRAWAL_ID_MISMATCH',
      message: 'Gen-4 APPLY hard-binds to the sole Owner-authorized canary withdrawal',
    });
  }

  const recon = evaluatePhase21Gen4ChainReconciliationFreshness(input.chainReconciliation);
  if (!recon.ok) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_CHAIN_RECON',
      refuseCode: 'GEN4_CHAIN_RECON_REQUIRED',
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
      refuseCode: 'GEN4_BINDINGS_WITHDRAWAL_MISMATCH',
      message: 'bindings.withdrawalId must equal APPLY withdrawalId',
    });
  }

  const deploymentEnvironment = input.deploymentEnvironment ?? 'LOCAL';

  const plan = await planPhase21Gen4Recovery(client, {
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
      refuseCode: 'GEN4_APPLY_PRECONDITIONS_FAILED',
      message: 'Gen-4 APPLY refused: PLAN FAIL checks present',
      planChecksFailed: hardFails.map((c) => c.id),
      plan,
    });
  }

  await client.query('BEGIN');
  try {
    const revalidated = await revalidateGen4MutablePreconditions(
      client,
      input.withdrawalId,
      bindings,
      allowNonCanary,
      deploymentEnvironment,
      input.chainReconciliation,
    );
    if (!revalidated.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_REVALIDATION',
        refuseCode: 'GEN4_APPLY_REVALIDATION_FAILED',
        message: revalidated.reason,
        planChecksFailed: revalidated.failed,
        plan,
      });
    }

    // Fresh chain recon must still be valid at mutation time.
    const reconAgain = evaluatePhase21Gen4ChainReconciliationFreshness(input.chainReconciliation);
    if (!reconAgain.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_CHAIN_RECON',
        refuseCode: 'GEN4_CHAIN_RECON_STALE_AT_MUTATION',
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
    const gen3 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
      client,
      input.withdrawalId,
      PHASE21_GEN3_AUTHORIZATION_GENERATION,
    );

    const armed = await armPhase21ManualDispatchPermitGeneration(client, {
      bindings,
      authorizationGeneration: PHASE21_GEN4_AUTHORIZATION_GENERATION,
      createdByAdminUserId: input.ownerTrust.adminUserId,
      idempotencyKey: phase21ManualDispatchGenerationIdempotencyKey(
        bindings.withdrawalId,
        PHASE21_GEN4_AUTHORIZATION_GENERATION,
      ),
      auditCorrelationId: `phase21-gen4-recovery-apply:${bindings.withdrawalId}`,
    });

    if (
      (gen1 !== null && armed.permit.id === gen1.id) ||
      (gen2 !== null && armed.permit.id === gen2.id) ||
      (gen3 !== null && armed.permit.id === gen3.id)
    ) {
      // Defensive: generation-unique index makes this unreachable; fail closed anyway.
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_PRIOR_PERMIT_REUSE',
        refuseCode: 'GEN4_PRIOR_PERMIT_REUSE_REFUSED',
        message: 'Gen-4 permit id collided with a prior generation permit',
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
      authorizationGeneration: PHASE21_GEN4_AUTHORIZATION_GENERATION,
      permitId: armed.permit.id,
      permitStatus: armed.permit.status,
      gen1PermitId: gen1?.id ?? null,
      gen1PermitStatus: gen1?.status ?? null,
      gen2PermitId: gen2?.id ?? null,
      gen2PermitStatus: gen2?.status ?? null,
      gen3PermitId: gen3?.id ?? null,
      gen3PermitStatus: gen3?.status ?? null,
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
      temporalStarted: false,
      broadcastPerformed: false,
      signed: false,
      readyForLivePayout: false,
      reservationReused: true,
      nextOperationalState:
        'GEN4_PERMIT_ARMED — Owner Gen-4 Temporal one-shot claim starts withdrawal/{id} with ALLOW_DUPLICATE; ' +
        'canonical pipeline creates attempt #4, consumes Gen-4 permit; Gen-1 + Gen-2 + Gen-3 CONSUMED preserved; ' +
        'relay stays OFF; Owner unlocks signer only during signing window; reconcile before any resend',
      message: armed.reused
        ? 'idempotent Gen-4 APPLY: existing Gen-4 permit reused; no broadcast'
        : 'Phase 21 Gen-4 recovery permit armed; no broadcast; canonical pipeline must execute',
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
      error instanceof WithdrawalDomainError ? error.code : 'GEN4_APPLY_MUTATION_FAILED';
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_MUTATION_ROLLBACK',
      refuseCode: code,
      message,
      plan,
    });
  }
}
