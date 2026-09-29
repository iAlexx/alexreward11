/**
 * Phase 17 Step 1 — durable withdrawal.confirmed Outbox after settlement authority.
 *
 * Spec mapping: Master Spec WITHDRAWAL_CONFIRMED domain event.
 * Insert ONLY after settleWithdrawalReservation succeeds in the same DB transaction.
 * No Telegram send. No payout_publications creation.
 */
import type { PoolClient } from 'pg';

import { insertWithdrawalOutboxEvent } from './audit.js';
import { WithdrawalDomainError } from './errors.js';

export const WITHDRAWAL_CONFIRMED_OUTBOX_EVENT = 'withdrawal.confirmed' as const;

export function withdrawalConfirmedDedupeKey(withdrawalId: string): string {
  return `withdrawal.confirmed:${withdrawalId}`;
}

export interface EnsureWithdrawalConfirmedOutboxInput {
  readonly withdrawalId: string;
  readonly confirmedAttemptId: string;
}

/**
 * Idempotent Outbox insert for confirmed+settled withdrawals.
 * Requires settlement_ledger_tx_id already present on the withdrawal row.
 */
export async function ensureWithdrawalConfirmedOutbox(
  client: PoolClient,
  input: EnsureWithdrawalConfirmedOutboxInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const withdrawalId = input.withdrawalId.trim();
  const confirmedAttemptId = input.confirmedAttemptId.trim();
  if (withdrawalId === '' || confirmedAttemptId === '') {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'withdrawalId and confirmedAttemptId are required',
    );
  }

  const row = await client.query<{
    state: string;
    confirmed_at: Date | null;
    settlement_ledger_tx_id: string | null;
  }>(
    `SELECT state::text AS state,
            confirmed_at,
            settlement_ledger_tx_id::text AS settlement_ledger_tx_id
     FROM withdrawals
     WHERE id = $1::uuid
     FOR SHARE`,
    [withdrawalId],
  );
  const w = row.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found for confirmed outbox');
  }
  if (w.state !== 'CONFIRMED') {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'withdrawal.confirmed Outbox requires CONFIRMED state',
      { details: { state: w.state } },
    );
  }
  if (w.confirmed_at === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'withdrawal.confirmed Outbox requires confirmed_at',
    );
  }
  if (w.settlement_ledger_tx_id === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'withdrawal.confirmed Outbox requires settlement_ledger_tx_id',
    );
  }

  const owned = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM withdrawal_attempts
     WHERE id = $1::uuid AND withdrawal_id = $2::uuid`,
    [confirmedAttemptId, withdrawalId],
  );
  if (owned.rows[0] === undefined) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'confirmedAttemptId does not belong to withdrawal',
      { details: { confirmedAttemptId, withdrawalId } },
    );
  }

  const dedupeKey = withdrawalConfirmedDedupeKey(withdrawalId);
  const existing = await client.query<{
    id: string;
    payload: { confirmedAttemptId?: string };
  }>(`SELECT id::text AS id, payload FROM outbox_events WHERE dedupe_key = $1`, [dedupeKey]);
  if (existing.rows[0] !== undefined) {
    const prior = existing.rows[0].payload?.confirmedAttemptId;
    if (prior !== undefined && prior !== confirmedAttemptId) {
      throw new WithdrawalDomainError(
        'INTERNAL',
        'withdrawal.confirmed Outbox dedupe conflict with different confirmedAttemptId',
        { details: { prior, confirmedAttemptId } },
      );
    }
    return { id: existing.rows[0].id, created: false };
  }

  return insertWithdrawalOutboxEvent(client, {
    aggregateType: 'withdrawal',
    aggregateId: withdrawalId,
    eventType: WITHDRAWAL_CONFIRMED_OUTBOX_EVENT,
    dedupeKey,
    payload: {
      schemaVersion: 1,
      withdrawalId,
      confirmedAttemptId,
    },
  });
}
