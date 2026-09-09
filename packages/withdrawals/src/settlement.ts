import type { PoolClient } from 'pg';

import {
  getOrCreateLedgerAccount,
  LedgerDomainError,
  postLedgerTransaction,
} from '@alex-rewards/ledger';

import { WithdrawalDomainError } from './errors.js';

/**
 * CONFIRMED settlement:
 * DR USER_RESERVED gross / CR HOT_WALLET_USDT_ASSET net / CR WITHDRAWAL_FEE_REVENUE fee
 */
export async function settleWithdrawalReservation(
  client: PoolClient,
  input: { readonly withdrawalId: string },
): Promise<{ settled: boolean; ledgerTxId: string | null }> {
  const row = await client.query<{
    id: string;
    user_id: string;
    asset_id: string;
    hot_wallet_id: string | null;
    requested_amount_atomic: string;
    fee_amount_atomic: string;
    net_amount_atomic: string;
    settlement_ledger_tx_id: string | null;
    release_ledger_tx_id: string | null;
    reservation_ledger_tx_id: string | null;
    state: string;
  }>(
    `SELECT id, user_id, asset_id, hot_wallet_id,
            requested_amount_atomic::text, fee_amount_atomic::text, net_amount_atomic::text,
            settlement_ledger_tx_id, release_ledger_tx_id, reservation_ledger_tx_id,
            state::text AS state
     FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
    [input.withdrawalId],
  );
  const w = row.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
  }
  if (w.settlement_ledger_tx_id !== null) {
    return { settled: false, ledgerTxId: w.settlement_ledger_tx_id };
  }
  if (w.release_ledger_tx_id !== null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Cannot settle after release');
  }
  if (w.reservation_ledger_tx_id === null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'No reservation to settle');
  }
  if (w.hot_wallet_id === null) {
    throw new WithdrawalDomainError('CONFIG', 'Hot wallet missing on withdrawal');
  }
  if (w.state !== 'CONFIRMED') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Settlement requires CONFIRMED state', {
      details: { state: w.state },
    });
  }

  const reserved = await getOrCreateLedgerAccount(client, {
    accountType: 'USER_RESERVED_LIABILITY',
    assetId: w.asset_id,
    ownerId: w.user_id,
  });
  const hot = await getOrCreateLedgerAccount(client, {
    accountType: 'HOT_WALLET_USDT_ASSET',
    assetId: w.asset_id,
    ownerId: w.hot_wallet_id,
  });
  const fee = await getOrCreateLedgerAccount(client, {
    accountType: 'WITHDRAWAL_FEE_REVENUE',
    assetId: w.asset_id,
  });

  const feeAtomic = BigInt(w.fee_amount_atomic);
  const entries = [
    {
      ledgerAccountId: reserved.id,
      direction: 'DEBIT' as const,
      amountAtomic: w.requested_amount_atomic,
    },
    {
      ledgerAccountId: hot.id,
      direction: 'CREDIT' as const,
      amountAtomic: w.net_amount_atomic,
    },
  ];
  if (feeAtomic > 0n) {
    entries.push({
      ledgerAccountId: fee.id,
      direction: 'CREDIT',
      amountAtomic: w.fee_amount_atomic,
    });
  }

  try {
    const tx = await postLedgerTransaction(client, {
      transactionType: 'WITHDRAWAL_SETTLEMENT',
      businessReferenceType: 'withdrawal',
      businessReferenceId: w.id,
      idempotencyScope: `withdrawal-settlement:${w.id}`,
      idempotencyKey: 'settlement',
      assetId: w.asset_id,
      entries,
    });

    await client.query(
      `UPDATE withdrawals
       SET settlement_ledger_tx_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid AND settlement_ledger_tx_id IS NULL`,
      [w.id, tx.id],
    );
    return { settled: true, ledgerTxId: tx.id };
  } catch (error) {
    if (error instanceof LedgerDomainError && error.code === 'IDEMPOTENCY_CONFLICT') {
      const existing = await client.query<{ settlement_ledger_tx_id: string | null }>(
        `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
        [w.id],
      );
      return {
        settled: false,
        ledgerTxId: existing.rows[0]?.settlement_ledger_tx_id ?? null,
      };
    }
    throw error;
  }
}
