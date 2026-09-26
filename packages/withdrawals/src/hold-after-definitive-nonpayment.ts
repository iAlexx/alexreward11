/**
 * Real-chain bridge: RECONCILE_REQUIRED → HELD after durable DEFINITIVE_NONPAYMENT.
 *
 * Purpose-specific Owner/domain command. Does NOT reject, release Reserved, settle,
 * sign, broadcast, queue, or approve. Zero ledger postings.
 *
 * Later Owner-authorized decideWithdrawal(REJECT, definitiveNonpayment:true) performs
 * HELD → REJECTED + WITHDRAWAL_RELEASE.
 */
import { insertWithdrawalAuditLog } from './audit.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import {
  DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
  type DefinitiveNonpaymentReasonCode,
} from './real-chain-reconcile-only.js';
import type { WithdrawalState } from './state-machine.js';
import { transitionWithdrawal } from './transitions.js';

export const HOLD_AFTER_DEFINITIVE_NONPAYMENT_ACTION =
  'WITHDRAWAL_HOLD_AFTER_DEFINITIVE_NONPAYMENT' as const;

export interface HoldReconciledWithdrawalAfterDefinitiveNonpaymentInput {
  readonly withdrawalId: string;
  /** Exact attempt that owns the durable DNP evidence. */
  readonly attemptId: string;
  /**
   * Optional specific reconciliation row. When omitted, the latest matching
   * DEFINITIVE_NONPAYMENT for this withdrawal+attempt+reason is used.
   */
  readonly reconciliationId?: string;
  /**
   * Required reason code. Defaults to the only real-chain DNP reason currently
   * implemented.
   */
  readonly expectedReason?: DefinitiveNonpaymentReasonCode;
  readonly idempotencyKey: string;
  readonly trustedOwnerActorContext?: { readonly adminUserId: string };
  readonly adminUserId?: string;
  readonly reason?: string;
}

export interface HoldReconciledWithdrawalAfterDefinitiveNonpaymentResult {
  readonly withdrawalId: string;
  readonly state: WithdrawalState;
  readonly heldFromReconcile: true;
  readonly reconciliationId: string;
  readonly attemptId: string;
  readonly definitiveNonpaymentReason: DefinitiveNonpaymentReasonCode;
  readonly alreadyApplied: boolean;
  readonly transitioned: boolean;
}

function extractReason(evidenceSummary: unknown): string | null {
  if (evidenceSummary === null || typeof evidenceSummary !== 'object') {
    return null;
  }
  const reason = (evidenceSummary as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Transition RECONCILE_REQUIRED → HELD with held_from_reconcile=true when durable
 * WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO (or other explicitly expected) DNP exists.
 *
 * Financial effect: NONE. Payout/sign/broadcast: NONE.
 */
export async function holdReconciledWithdrawalAfterDefinitiveNonpayment(
  db: WithdrawalDb,
  input: HoldReconciledWithdrawalAfterDefinitiveNonpaymentInput,
): Promise<HoldReconciledWithdrawalAfterDefinitiveNonpaymentResult> {
  if (input.idempotencyKey.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'idempotencyKey is required');
  }
  const adminUserId = input.trustedOwnerActorContext?.adminUserId ?? input.adminUserId;
  if (adminUserId === undefined || adminUserId.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'adminUserId is required');
  }
  const expectedReason =
    input.expectedReason ?? DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO;

  return withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      id: string;
      state: WithdrawalState;
      held_from_reconcile: boolean;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT id, state, held_from_reconcile,
              settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              confirmed_at
       FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
      [input.withdrawalId],
    );
    const w = locked.rows[0];
    if (w === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }

    // Attempt identity — must belong to this withdrawal.
    const attempt = await client.query<{ id: string; withdrawal_id: string }>(
      `SELECT id::text AS id, withdrawal_id::text AS withdrawal_id
       FROM withdrawal_attempts
       WHERE id = $1::uuid AND withdrawal_id = $2::uuid
       FOR UPDATE`,
      [input.attemptId, input.withdrawalId],
    );
    if (attempt.rows[0] === undefined) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Attempt not found for withdrawal (withdrawal/attempt association failed)',
      );
    }

    // Locate durable DNP proof for this withdrawal+attempt+reason.
    const dnpQuery = await client.query<{
      id: string;
      withdrawal_attempt_id: string;
      evidence_summary: unknown;
    }>(
      input.reconciliationId !== undefined
        ? `SELECT id::text AS id, withdrawal_attempt_id::text AS withdrawal_attempt_id,
                  evidence_summary
           FROM withdrawal_payout_reconciliations
           WHERE id = $1::uuid
             AND withdrawal_id = $2::uuid
             AND resolution = 'DEFINITIVE_NONPAYMENT'`
        : `SELECT id::text AS id, withdrawal_attempt_id::text AS withdrawal_attempt_id,
                  evidence_summary
           FROM withdrawal_payout_reconciliations
           WHERE withdrawal_id = $1::uuid
             AND withdrawal_attempt_id = $2::uuid
             AND resolution = 'DEFINITIVE_NONPAYMENT'
           ORDER BY created_at DESC
           LIMIT 5`,
      input.reconciliationId !== undefined
        ? [input.reconciliationId, input.withdrawalId]
        : [input.withdrawalId, input.attemptId],
    );

    if (dnpQuery.rows.length === 0) {
      throw new WithdrawalDomainError(
        'TRANSITION_FORBIDDEN',
        'Durable DEFINITIVE_NONPAYMENT evidence required for hold bridge',
      );
    }

    let matched:
      | { id: string; attemptId: string; reason: DefinitiveNonpaymentReasonCode }
      | undefined;
    for (const row of dnpQuery.rows) {
      if (row.withdrawal_attempt_id !== input.attemptId) {
        continue;
      }
      const reason = extractReason(row.evidence_summary);
      if (reason !== expectedReason) {
        continue;
      }
      matched = {
        id: row.id,
        attemptId: row.withdrawal_attempt_id,
        reason: reason as DefinitiveNonpaymentReasonCode,
      };
      break;
    }
    if (matched === undefined) {
      // Distinguish wrong-attempt vs wrong-reason for clearer fail-closed errors.
      const anyForWithdrawal = dnpQuery.rows.some((r) => r.withdrawal_attempt_id === input.attemptId);
      if (!anyForWithdrawal) {
        throw new WithdrawalDomainError(
          'TRANSITION_FORBIDDEN',
          'DEFINITIVE_NONPAYMENT evidence does not belong to the specified attempt',
        );
      }
      throw new WithdrawalDomainError(
        'TRANSITION_FORBIDDEN',
        `Unsupported or mismatched DEFINITIVE_NONPAYMENT reason (expected ${expectedReason})`,
      );
    }

    // Positive payout / settlement guards.
    if (w.settlement_ledger_tx_id !== null) {
      throw new WithdrawalDomainError(
        'STATE_CONFLICT',
        'Cannot hold after settlement',
      );
    }
    if (w.confirmed_at !== null || w.state === 'CONFIRMED') {
      throw new WithdrawalDomainError(
        'STATE_CONFLICT',
        'Cannot hold a confirmed withdrawal',
      );
    }

    const intended = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid
         AND resolution = 'INTENDED_PAYOUT_PROVEN'
       LIMIT 1`,
      [input.withdrawalId],
    );
    if (intended.rows[0] !== undefined) {
      throw new WithdrawalDomainError(
        'TRANSITION_FORBIDDEN',
        'INTENDED_PAYOUT_PROVEN exists — hold bridge refuse',
      );
    }

    // Idempotent success replay.
    if (w.state === 'HELD' && w.held_from_reconcile === true) {
      return {
        withdrawalId: w.id,
        state: 'HELD',
        heldFromReconcile: true,
        reconciliationId: matched.id,
        attemptId: matched.attemptId,
        definitiveNonpaymentReason: matched.reason,
        alreadyApplied: true,
        transitioned: false,
      };
    }

    // Wrong-kind HELD (normal Owner HOLD) must not be silently upgraded.
    if (w.state === 'HELD' && w.held_from_reconcile !== true) {
      throw new WithdrawalDomainError(
        'STATE_CONFLICT',
        'Withdrawal is HELD without held_from_reconcile — refuse silent upgrade',
      );
    }

    if (w.state !== 'RECONCILE_REQUIRED') {
      throw new WithdrawalDomainError('STATE_CONFLICT', 'Expected RECONCILE_REQUIRED', {
        details: { actual: w.state },
      });
    }

    await transitionWithdrawal(client, {
      id: w.id,
      from: 'RECONCILE_REQUIRED',
      to: 'HELD',
      setHeldFromReconcile: true,
    });

    const reasonTag = `idempotency:${input.idempotencyKey}|${input.reason ?? 'dnp-hold-bridge'}`;
    await insertWithdrawalAuditLog(client, {
      actionType: HOLD_AFTER_DEFINITIVE_NONPAYMENT_ACTION,
      resourceType: 'withdrawal',
      resourceId: w.id,
      actorType: 'ADMIN',
      adminUserId,
      reason: reasonTag,
      afterSnapshot: {
        state: 'HELD',
        heldFromReconcile: true,
        reconciliationId: matched.id,
        attemptId: matched.attemptId,
        definitiveNonpaymentReason: matched.reason,
        neverRelease: true,
        neverReject: true,
        neverSettle: true,
      },
    });

    return {
      withdrawalId: w.id,
      state: 'HELD',
      heldFromReconcile: true,
      reconciliationId: matched.id,
      attemptId: matched.attemptId,
      definitiveNonpaymentReason: matched.reason,
      alreadyApplied: false,
      transitioned: true,
    };
  });
}
