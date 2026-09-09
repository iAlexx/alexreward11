import type { PoolClient } from 'pg';

import {
  getOrCreateLedgerAccount,
  LedgerDomainError,
  postLedgerTransaction,
} from '@alex-rewards/ledger';

import { WithdrawalDomainError } from './errors.js';

/**
 * REJECTED / failed pre-broadcast: move gross Reserved → Available once.
 */
export async function releaseWithdrawalReservation(
  client: PoolClient,
  input: { readonly withdrawalId: string },
): Promise<{ released: boolean; ledgerTxId: string | null }> {
  const row = await client.query<{
    id: string;
    user_id: string;
    asset_id: string;
    requested_amount_atomic: string;
    release_ledger_tx_id: string | null;
    reservation_ledger_tx_id: string | null;
    settlement_ledger_tx_id: string | null;
    state: string;
  }>(
    `SELECT id, user_id, asset_id, requested_amount_atomic::text,
            release_ledger_tx_id, reservation_ledger_tx_id, settlement_ledger_tx_id,
            state::text AS state
     FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
    [input.withdrawalId],
  );
  const w = row.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
  }
  if (w.release_ledger_tx_id !== null) {
    return { released: false, ledgerTxId: w.release_ledger_tx_id };
  }
  if (w.settlement_ledger_tx_id !== null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Cannot release after settlement');
  }
  if (w.reservation_ledger_tx_id === null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'No reservation to release');
  }

  const available = await getOrCreateLedgerAccount(client, {
    accountType: 'USER_AVAILABLE_LIABILITY',
    assetId: w.asset_id,
    ownerId: w.user_id,
  });
  const reserved = await getOrCreateLedgerAccount(client, {
    accountType: 'USER_RESERVED_LIABILITY',
    assetId: w.asset_id,
    ownerId: w.user_id,
  });

  try {
    const tx = await postLedgerTransaction(client, {
      transactionType: 'WITHDRAWAL_RELEASE',
      businessReferenceType: 'withdrawal',
      businessReferenceId: w.id,
      idempotencyScope: `withdrawal-release:${w.id}`,
      idempotencyKey: 'release',
      assetId: w.asset_id,
      entries: [
        {
          ledgerAccountId: reserved.id,
          direction: 'DEBIT',
          amountAtomic: w.requested_amount_atomic,
        },
        {
          ledgerAccountId: available.id,
          direction: 'CREDIT',
          amountAtomic: w.requested_amount_atomic,
        },
      ],
    });

    await client.query(
      `UPDATE withdrawals
       SET release_ledger_tx_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid AND release_ledger_tx_id IS NULL`,
      [w.id, tx.id],
    );
    return { released: true, ledgerTxId: tx.id };
  } catch (error) {
    if (error instanceof LedgerDomainError && error.code === 'IDEMPOTENCY_CONFLICT') {
      const existing = await client.query<{ release_ledger_tx_id: string | null }>(
        `SELECT release_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
        [w.id],
      );
      return {
        released: false,
        ledgerTxId: existing.rows[0]?.release_ledger_tx_id ?? null,
      };
    }
    throw error;
  }
}
