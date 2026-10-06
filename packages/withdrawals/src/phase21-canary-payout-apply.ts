/**
 * Phase 21 Mainnet canary payout APPLY — arms one-shot manual dispatch permit only.
 *
 * NEVER signs, NEVER broadcasts, NEVER unlocks signer, NEVER globally unpauses dispatch.
 * Canonical Worker / Temporal / real-payout-pipeline performs financial execution after
 * the permit is armed and the outbox restart is relayed.
 *
 * Mutation contract: ONE DB transaction — FOR UPDATE revalidation + arm permit + audit +
 * enqueue outbox, or ROLLBACK all. applied=false means nothing committed.
 */
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import {
  assertPhase21CanaryPayoutApplyConfirmation,
  type Phase21CanaryPayoutApplyConfirmation,
} from './phase21-ceremony-confirmations.js';
import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  planPhase21CanaryPayout,
  type Phase21CanaryPayoutEnvObservations,
  type Phase21CanaryPayoutPlanClient,
  type Phase21CanaryPayoutSignerProbe,
} from './phase21-canary-payout-plan.js';
import { PHASE21_NETWORK_CODE } from './phase21-config.js';
import {
  armPhase21ManualDispatchPermit,
  enqueuePhase21ManualDispatchOutbox,
  phase21CanaryManualDispatchIdempotencyKey,
  type Phase21ManualDispatchPermitBindings,
  type Phase21ManualDispatchPermitRow,
} from './phase21-manual-dispatch-permit.js';
import {
  assertAuthenticatedPhase21OwnerCeremonyTrust,
  type AuthenticatedPhase21OwnerCeremonyTrust,
} from './phase21-owner-ceremony-trust.js';
import { withdrawalWorkflowId } from './outbox.js';

export const PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS: Phase21ManualDispatchPermitBindings = {
  withdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  authorizedGrossAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  authorizedFeeAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  authorizedNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  authorizedRecipientFriendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  authorizedRecipientRaw: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  authorizedNetworkCode: PHASE21_NETWORK_CODE,
  authorizedAssetSymbol: 'USDT',
  authorizedJettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  authorizedAttachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  authorizedForwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
};

export interface Phase21CanaryPayoutApplyResult {
  readonly ok: boolean;
  readonly mode: 'APPLY';
  readonly applied: boolean;
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly permitId: string | null;
  readonly permitStatus: Phase21ManualDispatchPermitRow['status'] | null;
  readonly created: boolean;
  readonly reused: boolean;
  readonly workflowId: string;
  readonly outboxEventId: string | null;
  /** True when this APPLY inserted a new outbox row. */
  readonly outboxCreated: boolean;
  /** True when an existing outbox row was reused (idempotent APPLY). */
  readonly outboxExisting: boolean;
  /**
   * True when an outbox row is present after APPLY (created or reused).
   * Never the tautology `created || !created`.
   */
  readonly outboxEnqueued: boolean;
  readonly generalDispatchPausePreserved: true;
  readonly generalWithdrawalIntakePreserved: true;
  readonly autoPayoutStillDisabled: true;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly readyForLivePayout: false;
  readonly nextOperationalState: string;
  readonly refuseCode?: string;
  readonly message?: string;
  readonly planChecksFailed?: ReadonlyArray<string>;
}

function refuseApply(
  partial: Omit<
    Phase21CanaryPayoutApplyResult,
    | 'ok'
    | 'mode'
    | 'applied'
    | 'broadcastPerformed'
    | 'signed'
    | 'readyForLivePayout'
    | 'generalDispatchPausePreserved'
    | 'generalWithdrawalIntakePreserved'
    | 'autoPayoutStillDisabled'
  >,
): Phase21CanaryPayoutApplyResult {
  return {
    ok: false,
    mode: 'APPLY',
    applied: false,
    broadcastPerformed: false,
    signed: false,
    readyForLivePayout: false,
    generalDispatchPausePreserved: true,
    generalWithdrawalIntakePreserved: true,
    autoPayoutStillDisabled: true,
    ...partial,
  };
}

function emptyRefuseFields(withdrawalId: string): Omit<
  Phase21CanaryPayoutApplyResult,
  | 'ok'
  | 'mode'
  | 'applied'
  | 'broadcastPerformed'
  | 'signed'
  | 'readyForLivePayout'
  | 'generalDispatchPausePreserved'
  | 'generalWithdrawalIntakePreserved'
  | 'autoPayoutStillDisabled'
  | 'nextOperationalState'
  | 'refuseCode'
  | 'message'
  | 'planChecksFailed'
> {
  return {
    withdrawalId,
    publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
    permitId: null,
    permitStatus: null,
    created: false,
    reused: false,
    workflowId: withdrawalWorkflowId(withdrawalId),
    outboxEventId: null,
    outboxCreated: false,
    outboxExisting: false,
    outboxEnqueued: false,
  };
}

function assertFrozenCanaryBindings(bindings: Phase21ManualDispatchPermitBindings): void {
  if (
    bindings.withdrawalId !== PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID ||
    bindings.publicId !== PHASE21_CANARY_PAYOUT_PUBLIC_ID ||
    bindings.authorizedGrossAtomic !== PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC ||
    bindings.authorizedFeeAtomic !== PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC ||
    bindings.authorizedNetAtomic !== PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC ||
    bindings.authorizedRecipientFriendly !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY ||
    bindings.authorizedRecipientRaw !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW ||
    bindings.authorizedNetworkCode !== PHASE21_NETWORK_CODE ||
    bindings.authorizedAssetSymbol !== 'USDT' ||
    bindings.authorizedJettonMaster !==
      PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster ||
    bindings.authorizedAttachedGramAtomic !== PHASE21_CANARY_ATTACHED_GRAM_ATOMIC ||
    bindings.authorizedForwardGramAtomic !== PHASE21_CANARY_FORWARD_TON_ATOMIC
  ) {
    throw new WithdrawalDomainError('CONFIG', 'canary permit bindings corrupted');
  }
}

/**
 * Revalidate mutable canary preconditions under row lock inside the mutation txn.
 * PLAN snapshot is advisory only — mutation must not trust it alone.
 */
async function revalidateCanaryMutablePreconditions(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  withdrawalId: string,
): Promise<{ ok: true } | { ok: false; reason: string; failed: string[] }> {
  const failed: string[] = [];

  const locked = await client.query<{
    id: string;
    public_id: string;
    state: string;
    requested_amount_atomic: string;
    fee_amount_atomic: string;
    net_amount_atomic: string;
    wallet_id: string;
    network_code: string;
  }>(
    `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
            w.requested_amount_atomic::text AS requested_amount_atomic,
            w.fee_amount_atomic::text AS fee_amount_atomic,
            w.net_amount_atomic::text AS net_amount_atomic,
            w.wallet_id::text AS wallet_id,
            n.code AS network_code
     FROM withdrawals w
     JOIN networks n ON n.id = w.network_id
     WHERE w.id = $1::uuid
     FOR UPDATE OF w`,
    [withdrawalId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    return { ok: false, reason: 'withdrawal missing under lock', failed: ['withdrawal_present'] };
  }
  if (row.public_id !== PHASE21_CANARY_PAYOUT_PUBLIC_ID) failed.push('public_id');
  if (row.state !== 'APPROVED') failed.push('state_approved');
  if (row.requested_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10)) {
    failed.push('gross_atomic');
  }
  if (row.fee_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10)) {
    failed.push('fee_atomic');
  }
  if (row.net_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10)) {
    failed.push('net_atomic');
  }
  if (row.network_code !== PHASE21_NETWORK_CODE) failed.push('network_code');

  const approvals = await client.query<{ c: number; approve_count: number }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (WHERE decision::text = 'APPROVE')::int AS approve_count
     FROM withdrawal_approvals
     WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  const approvalCount = approvals.rows[0]?.c ?? 0;
  const approveCount = approvals.rows[0]?.approve_count ?? 0;
  if (!(approvalCount === 1 && approveCount === 1)) failed.push('exactly_one_approval');

  const attempts = await client.query<{
    c: number;
    signature_evidence: number;
    submitted: number;
    chain_ref: number;
    broadcast_started: number;
    ambiguous: number;
  }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (
              WHERE signed_external_message_boc IS NOT NULL
                 OR signed_wallet_request_boc IS NOT NULL
                 OR external_message_cell_hash IS NOT NULL
                 OR normalized_external_message_hash IS NOT NULL
                 OR signed_message_hash IS NOT NULL
            )::int AS signature_evidence,
            count(*) FILTER (WHERE broadcast_submitted_at IS NOT NULL)::int AS submitted,
            count(*) FILTER (
              WHERE chain_reference IS NOT NULL AND btrim(chain_reference) <> ''
            )::int AS chain_ref,
            count(*) FILTER (WHERE broadcast_started_at IS NOT NULL)::int AS broadcast_started,
            count(*) FILTER (
              WHERE broadcast_result_state::text IN (
                'PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'
              )
            )::int AS ambiguous
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  const attemptCount = attempts.rows[0]?.c ?? 0;
  if (attemptCount !== 0) failed.push('zero_attempts');
  if ((attempts.rows[0]?.signature_evidence ?? 0) !== 0) failed.push('no_signature_evidence');
  if ((attempts.rows[0]?.submitted ?? 0) !== 0) failed.push('no_submitted');
  if ((attempts.rows[0]?.chain_ref ?? 0) !== 0) failed.push('no_chain_ref');
  if ((attempts.rows[0]?.broadcast_started ?? 0) !== 0) failed.push('no_broadcast_started');
  if ((attempts.rows[0]?.ambiguous ?? 0) !== 0) failed.push('no_ambiguous');

  const wallet = await client.query<{
    friendly_address: string;
    raw_address: string;
    verified: boolean;
    disabled_at: Date | null;
    network_code: string;
  }>(
    `SELECT uw.friendly_address, uw.raw_address, uw.verified, uw.disabled_at,
            n.code AS network_code
     FROM user_wallets uw
     JOIN networks n ON n.id = uw.network_id
     WHERE uw.id = $1::uuid`,
    [row.wallet_id],
  );
  const walletRow = wallet.rows[0];
  if (walletRow === undefined) {
    failed.push('recipient_wallet');
  } else {
    if (walletRow.friendly_address !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY) {
      failed.push('recipient_friendly');
    }
    if (walletRow.raw_address !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW) {
      failed.push('recipient_raw');
    }
    if (walletRow.verified !== true) failed.push('recipient_verified');
    if (walletRow.disabled_at !== null) failed.push('recipient_not_disabled');
    if (walletRow.network_code !== PHASE21_NETWORK_CODE) failed.push('recipient_network');
  }

  if (failed.length > 0) {
    return {
      ok: false,
      reason: 'mutable canary preconditions failed under FOR UPDATE lock',
      failed,
    };
  }
  return { ok: true };
}

/**
 * APPLY: Owner confirmation + PLAN soft precheck (outside mutation txn), then one
 * mutation transaction: FOR UPDATE revalidation + arm permit + audit + outbox.
 * No broadcast. Jetton master is frozen to PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.
 */
export async function applyPhase21CanaryPayout(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly ownerTrust: AuthenticatedPhase21OwnerCeremonyTrust;
    readonly applyConfirmation: Phase21CanaryPayoutApplyConfirmation;
    readonly env?: Phase21CanaryPayoutEnvObservations;
    readonly signerProbe?: Phase21CanaryPayoutSignerProbe;
    /**
     * Optional equality check only. Must match frozen canonical jetton master when provided.
     * Never overrides PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster.
     * env.jettonMaster is ignored for mutation bindings.
     */
    readonly jettonMaster?: string | null;
  },
): Promise<Phase21CanaryPayoutApplyResult> {
  if (PHASE21_CANARY_PAYOUT_APPLY_ENABLED !== true) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'APPLY_DISABLED',
      refuseCode: 'PHASE21_CANARY_PAYOUT_APPLY_NOT_ENABLED',
      message: 'Phase 21 canary APPLY is not enabled in this source slice',
    });
  }

  assertAuthenticatedPhase21OwnerCeremonyTrust(input.ownerTrust);
  assertPhase21CanaryPayoutApplyConfirmation(input.applyConfirmation);

  if (input.withdrawalId !== PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_WRONG_WITHDRAWAL',
      refuseCode: 'CANARY_WITHDRAWAL_ID_MISMATCH',
      message: 'APPLY hard-binds to the sole Owner-authorized canary withdrawal',
    });
  }

  // Jetton master is frozen — refuse mismatched override; ignore env override.
  if (
    input.jettonMaster !== undefined &&
    input.jettonMaster !== null &&
    input.jettonMaster !== '' &&
    input.jettonMaster !== PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster
  ) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_JETTON_MASTER',
      refuseCode: 'CANARY_JETTON_MASTER_MISMATCH',
      message:
        'APPLY refuses jettonMaster override; must equal frozen PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS.authorizedJettonMaster',
    });
  }

  // Soft precheck OUTSIDE mutation txn (plan uses BEGIN READ ONLY / ROLLBACK).
  const plan = await planPhase21CanaryPayout(client, {
    withdrawalId: input.withdrawalId,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.signerProbe !== undefined ? { signerProbe: input.signerProbe } : {}),
  });

  const hardFails = plan.checks.filter(
    (c) => c.status === 'FAIL' && c.id !== 'signer_locked',
  );
  // Workstation Tailscale may not reach signer — classify as probe-required, not APPLY refuse.
  // Trusted-runtime signer check remains mandatory before actual signing in the Worker pipeline.
  const signerFail = plan.checks.find((c) => c.id === 'signer_locked' && c.status === 'FAIL');
  const signerUnlocked =
    signerFail !== undefined &&
    typeof signerFail.actual === 'object' &&
    signerFail.actual !== null &&
    (signerFail.actual as { locked?: unknown }).locked === false;

  if (hardFails.length > 0 || signerUnlocked) {
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_PRECONDITIONS',
      refuseCode: 'CANARY_APPLY_PRECONDITIONS_FAILED',
      message: 'canary APPLY refused: PLAN FAIL checks present',
      planChecksFailed: (signerUnlocked ? [...hardFails, signerFail!] : hardFails).map((c) => c.id),
    });
  }

  const bindings = PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS;
  assertFrozenCanaryBindings(bindings);

  // APPLY owns BEGIN/COMMIT/ROLLBACK on the provided client (not nested SAVEPOINT).
  await client.query('BEGIN');
  try {
    const revalidated = await revalidateCanaryMutablePreconditions(client, input.withdrawalId);
    if (!revalidated.ok) {
      await client.query('ROLLBACK');
      return refuseApply({
        ...emptyRefuseFields(input.withdrawalId),
        nextOperationalState: 'REFUSED_REVALIDATION',
        refuseCode: 'CANARY_APPLY_REVALIDATION_FAILED',
        message: revalidated.reason,
        planChecksFailed: revalidated.failed,
      });
    }

    const armed = await armPhase21ManualDispatchPermit(client, {
      bindings,
      createdByAdminUserId: input.ownerTrust.adminUserId,
      idempotencyKey: phase21CanaryManualDispatchIdempotencyKey(bindings.withdrawalId),
      auditCorrelationId: `phase21-canary-apply:${bindings.withdrawalId}`,
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
      permitId: armed.permit.id,
      permitStatus: armed.permit.status,
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
      nextOperationalState:
        'PERMIT_ARMED — Worker outbox relay restarts withdrawal/{id} with ALLOW_DUPLICATE; ' +
        'canonical pipeline consumes permit at pause gate; Owner unlocks signer only during signing window; ' +
        'reconcile before any resend; relock signer after ceremony',
      message: armed.reused
        ? 'idempotent APPLY: existing Phase 21 manual dispatch permit reused; no broadcast'
        : 'Phase 21 manual dispatch permit armed; no broadcast; canonical pipeline must execute',
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort rollback; surface original error
    }
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof WithdrawalDomainError ? error.code : 'CANARY_APPLY_MUTATION_FAILED';
    return refuseApply({
      ...emptyRefuseFields(input.withdrawalId),
      nextOperationalState: 'REFUSED_MUTATION_ROLLBACK',
      refuseCode: code,
      message,
    });
  }
}
