import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import type { WithdrawalView } from './create.js';
import type { WithdrawalState } from './state-machine.js';

function mapWithdrawal(row: {
  id: string;
  public_id: string;
  user_id: string;
  withdrawal_quote_id: string;
  state: WithdrawalState;
  requested_amount_atomic: string;
  fee_amount_atomic: string;
  net_amount_atomic: string;
  priority_review: boolean;
  risk_decision: string | null;
  workflow_id: string | null;
}): WithdrawalView {
  return {
    id: row.id,
    publicId: row.public_id,
    userId: row.user_id,
    quoteId: row.withdrawal_quote_id,
    state: row.state,
    requestedAmountAtomic: row.requested_amount_atomic,
    feeAmountAtomic: row.fee_amount_atomic,
    netAmountAtomic: row.net_amount_atomic,
    priorityReview: row.priority_review,
    riskDecision: row.risk_decision,
    workflowId: row.workflow_id,
  };
}

const SELECT = `id, public_id, user_id, withdrawal_quote_id, state,
  requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
  priority_review, risk_decision::text AS risk_decision, workflow_id`;

export async function getWithdrawal(
  db: WithdrawalDb,
  input: { readonly withdrawalId: string; readonly authenticatedUserId?: string },
): Promise<WithdrawalView> {
  return withWithdrawalTransaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      public_id: string;
      user_id: string;
      withdrawal_quote_id: string;
      state: WithdrawalState;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      priority_review: boolean;
      risk_decision: string | null;
      workflow_id: string | null;
    }>(`SELECT ${SELECT} FROM withdrawals WHERE id = $1::uuid`, [input.withdrawalId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }
    if (input.authenticatedUserId !== undefined && row.user_id !== input.authenticatedUserId) {
      throw new WithdrawalDomainError('UNAUTHORIZED', 'Authentication required');
    }
    return mapWithdrawal(row);
  });
}

export async function listWithdrawalsForUser(
  db: WithdrawalDb,
  input: { readonly authenticatedUserId: string; readonly limit?: number },
): Promise<readonly WithdrawalView[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return withWithdrawalTransaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      public_id: string;
      user_id: string;
      withdrawal_quote_id: string;
      state: WithdrawalState;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      priority_review: boolean;
      risk_decision: string | null;
      workflow_id: string | null;
    }>(
      `SELECT ${SELECT}
       FROM withdrawals
       WHERE user_id = $1::uuid
       ORDER BY requested_at DESC
       LIMIT $2`,
      [input.authenticatedUserId, limit],
    );
    return result.rows.map(mapWithdrawal);
  });
}
