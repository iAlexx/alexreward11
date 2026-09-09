import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import { assertTransitionAllowed, type WithdrawalState } from './state-machine.js';

export interface TransitionWithdrawalInput {
  readonly id: string;
  readonly from: WithdrawalState;
  readonly to: WithdrawalState;
  readonly heldFromReconcile?: boolean;
  readonly definitiveNonpayment?: boolean;
  readonly setHeldFromReconcile?: boolean;
  readonly workflowId?: string | null;
  readonly riskPolicyVersion?: number | null;
  readonly riskDecision?: string | null;
  readonly riskSnapshotId?: string | null;
  readonly reservationLedgerTxId?: string | null;
  readonly releaseLedgerTxId?: string | null;
  readonly settlementLedgerTxId?: string | null;
}

/**
 * Assert allowed transition then UPDATE … WHERE state = $from.
 * Zero rows → STATE_CONFLICT (expected-state predicate failed).
 */
export async function transitionWithdrawal(
  client: PoolClient,
  input: TransitionWithdrawalInput,
): Promise<{ id: string; state: WithdrawalState }> {
  try {
    const options: {
      heldFromReconcile?: boolean;
      definitiveNonpayment?: boolean;
    } = {};
    if (input.heldFromReconcile !== undefined) {
      options.heldFromReconcile = input.heldFromReconcile;
    }
    if (input.definitiveNonpayment !== undefined) {
      options.definitiveNonpayment = input.definitiveNonpayment;
    }
    assertTransitionAllowed(input.from, input.to, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TRANSITION_FORBIDDEN';
    throw new WithdrawalDomainError('TRANSITION_FORBIDDEN', message, { cause: error });
  }

  const timestampColumn = timestampForState(input.to);

  const result = await client.query<{ id: string; state: WithdrawalState }>(
    `UPDATE withdrawals SET
       state = $2::withdrawal_state,
       updated_at = now(),
       ${timestampColumn !== null ? `${timestampColumn} = COALESCE(${timestampColumn}, now()),` : ''}
       held_from_reconcile = CASE
         WHEN $3::boolean IS TRUE THEN true
         ELSE held_from_reconcile
       END,
       workflow_id = COALESCE($4, workflow_id),
       risk_policy_version = COALESCE($5, risk_policy_version),
       risk_decision = COALESCE($6::withdrawal_risk_decision, risk_decision),
       risk_snapshot_id = COALESCE($7::uuid, risk_snapshot_id),
       reservation_ledger_tx_id = COALESCE($8::uuid, reservation_ledger_tx_id),
       release_ledger_tx_id = COALESCE($9::uuid, release_ledger_tx_id),
       settlement_ledger_tx_id = COALESCE($10::uuid, settlement_ledger_tx_id)
     WHERE id = $1::uuid AND state = $11::withdrawal_state
     RETURNING id, state`,
    [
      input.id,
      input.to,
      input.setHeldFromReconcile === true,
      input.workflowId ?? null,
      input.riskPolicyVersion ?? null,
      input.riskDecision ?? null,
      input.riskSnapshotId ?? null,
      input.reservationLedgerTxId ?? null,
      input.releaseLedgerTxId ?? null,
      input.settlementLedgerTxId ?? null,
      input.from,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Withdrawal state conflict', {
      details: { id: input.id, expected: input.from, attempted: input.to },
    });
  }
  return row;
}

function timestampForState(state: WithdrawalState): string | null {
  switch (state) {
    case 'APPROVED':
      return 'approved_at';
    case 'QUEUED':
      return 'queued_at';
    case 'BROADCASTED':
      return 'broadcasted_at';
    case 'CONFIRMED':
      return 'confirmed_at';
    case 'HELD':
      return 'held_at';
    case 'REJECTED':
      return 'rejected_at';
    default:
      return null;
  }
}
