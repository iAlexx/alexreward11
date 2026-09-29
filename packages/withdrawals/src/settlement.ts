import type { PoolClient } from 'pg';

import {
  getOrCreateLedgerAccount,
  LedgerDomainError,
  postLedgerTransaction,
  resolveHotWalletAssetAccountType,
} from '@alex-rewards/ledger';

import { WithdrawalDomainError } from './errors.js';
import { ensureWithdrawalConfirmedOutbox } from './public-payout-outbox.js';

export interface SettleWithdrawalReservationInput {
  readonly withdrawalId: string;
  /**
   * Authoritative attempt proven by independently verified confirmation evidence.
   * When omitted, resolved from durable INTENDED_PAYOUT_PROVEN (exactly one attempt).
   */
  readonly confirmedAttemptId?: string;
}

/**
 * CONFIRMED settlement:
 * DR USER_RESERVED gross / CR Hot Wallet asset inventory net / CR WITHDRAWAL_FEE_REVENUE fee
 *
 * Hot Wallet inventory account type is asset-aware:
 *   USDT  → HOT_WALLET_USDT_ASSET
 *   aalex → HOT_WALLET_JETTON_ASSET (allowlisted Testnet Jetton)
 *
 * Stamps settled_at ONLY on the evidence-backed confirmed attempt — never on every
 * broadcast_submitted_at row for the withdrawal.
 */
export async function settleWithdrawalReservation(
  client: PoolClient,
  input: SettleWithdrawalReservationInput,
): Promise<{ settled: boolean; ledgerTxId: string | null; confirmedAttemptId: string }> {
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

  const confirmedAttemptId = await resolveConfirmedAttemptId(client, {
    withdrawalId: w.id,
    ...(input.confirmedAttemptId !== undefined
      ? { confirmedAttemptId: input.confirmedAttemptId }
      : {}),
    allowAlreadySettledHeal: w.settlement_ledger_tx_id !== null,
  });

  if (w.settlement_ledger_tx_id !== null) {
    // Heal path: ledger already settled — stamp only the authoritative confirmed attempt.
    await stampSettledConfirmedAttempt(client, {
      withdrawalId: w.id,
      attemptId: confirmedAttemptId,
    });
    // Phase17: durable withdrawal.confirmed after settlement authority (heal path).
    await ensureWithdrawalConfirmedOutbox(client, {
      withdrawalId: w.id,
      confirmedAttemptId,
    });
    return {
      settled: false,
      ledgerTxId: w.settlement_ledger_tx_id,
      confirmedAttemptId,
    };
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

  const hotWalletAccountType = await resolveHotWalletAssetAccountType(client, w.asset_id);
  const reserved = await getOrCreateLedgerAccount(client, {
    accountType: 'USER_RESERVED_LIABILITY',
    assetId: w.asset_id,
    ownerId: w.user_id,
  });
  const hot = await getOrCreateLedgerAccount(client, {
    accountType: hotWalletAccountType,
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
    await stampSettledConfirmedAttempt(client, {
      withdrawalId: w.id,
      attemptId: confirmedAttemptId,
    });
    // Phase17: Outbox commits atomically with settlement; failure rolls back this TX.
    await ensureWithdrawalConfirmedOutbox(client, {
      withdrawalId: w.id,
      confirmedAttemptId,
    });
    return { settled: true, ledgerTxId: tx.id, confirmedAttemptId };
  } catch (error) {
    if (error instanceof LedgerDomainError && error.code === 'IDEMPOTENCY_CONFLICT') {
      const existing = await client.query<{ settlement_ledger_tx_id: string | null }>(
        `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
        [w.id],
      );
      await stampSettledConfirmedAttempt(client, {
        withdrawalId: w.id,
        attemptId: confirmedAttemptId,
      });
      await ensureWithdrawalConfirmedOutbox(client, {
        withdrawalId: w.id,
        confirmedAttemptId,
      });
      return {
        settled: false,
        ledgerTxId: existing.rows[0]?.settlement_ledger_tx_id ?? null,
        confirmedAttemptId,
      };
    }
    throw error;
  }
}

/**
 * Resolve the single evidence-backed confirmed attempt for settlement attribution.
 * Fail closed when confirmation cannot be attributed unambiguously.
 * Never assume "latest attempt_number" is the confirmed attempt.
 */
async function resolveConfirmedAttemptId(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly confirmedAttemptId?: string;
    /** When ledger settlement already exists, allow resolving via prior settled_at. */
    readonly allowAlreadySettledHeal?: boolean;
  },
): Promise<string> {
  const provenAttempts = await client.query<{ attempt_id: string }>(
    `SELECT DISTINCT withdrawal_attempt_id::text AS attempt_id
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_id = $1::uuid
       AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
    [input.withdrawalId],
  );
  const provenIds = provenAttempts.rows.map((r) => r.attempt_id);

  if (input.confirmedAttemptId !== undefined) {
    const owned = await client.query<{
      id: string;
      broadcast_result_state: string;
      settled_at: Date | null;
    }>(
      `SELECT id::text AS id,
              broadcast_result_state::text AS broadcast_result_state,
              settled_at
       FROM withdrawal_attempts
       WHERE id = $1::uuid AND withdrawal_id = $2::uuid`,
      [input.confirmedAttemptId, input.withdrawalId],
    );
    if (owned.rows[0] === undefined) {
      throw new WithdrawalDomainError(
        'RECONCILE_REQUIRED',
        'Confirmed attempt does not belong to this withdrawal',
        { details: { attemptId: input.confirmedAttemptId, withdrawalId: input.withdrawalId } },
      );
    }

    // Durable proof for this exact attempt wins.
    if (provenIds.includes(input.confirmedAttemptId)) {
      return input.confirmedAttemptId;
    }
    // Idempotent heal of an already-stamped confirmed attempt.
    if (owned.rows[0].settled_at !== null) {
      return input.confirmedAttemptId;
    }
    // Another attempt already holds INTENDED_PAYOUT_PROVEN — never stamp a newer
    // BROADCASTED/UNKNOWN sibling merely because it was passed as "latest".
    if (provenIds.length > 0) {
      throw new WithdrawalDomainError(
        'RECONCILE_REQUIRED',
        'Confirmed attempt attribution does not match durable INTENDED_PAYOUT_PROVEN',
        {
          details: {
            attemptedId: input.confirmedAttemptId,
            provenAttemptIds: provenIds,
          },
        },
      );
    }
    // No proof rows yet (e.g. fake-chain path): reject UNKNOWN; allow BROADCASTED.
    if (owned.rows[0].broadcast_result_state === 'UNKNOWN') {
      throw new WithdrawalDomainError(
        'RECONCILE_REQUIRED',
        'Cannot settle UNKNOWN attempt without INTENDED_PAYOUT_PROVEN evidence',
        { details: { attemptId: input.confirmedAttemptId } },
      );
    }
    return input.confirmedAttemptId;
  }

  if (provenIds.length === 1) {
    return provenIds[0]!;
  }
  if (provenIds.length > 1) {
    throw new WithdrawalDomainError(
      'RECONCILE_REQUIRED',
      'Ambiguous confirmation: multiple INTENDED_PAYOUT_PROVEN attempts',
      {
        details: {
          withdrawalId: input.withdrawalId,
          attemptIds: provenIds,
        },
      },
    );
  }

  if (input.allowAlreadySettledHeal === true) {
    // Prefer previously settled identity that also has durable proof when present;
    // otherwise the single settled attempt (never "latest unsettled BROADCASTED").
    const already = await client.query<{ attempt_id: string }>(
      `SELECT a.id::text AS attempt_id
       FROM withdrawal_attempts a
       WHERE a.withdrawal_id = $1::uuid
         AND a.settled_at IS NOT NULL
       ORDER BY a.attempt_number ASC`,
      [input.withdrawalId],
    );
    if (already.rows.length === 1) {
      return already.rows[0]!.attempt_id;
    }
    if (already.rows.length > 1) {
      // Multiple settled rows should not happen; fail closed rather than pick "latest".
      throw new WithdrawalDomainError(
        'RECONCILE_REQUIRED',
        'Ambiguous settled attempt identities during settlement heal',
        {
          details: {
            withdrawalId: input.withdrawalId,
            attemptIds: already.rows.map((r) => r.attempt_id),
          },
        },
      );
    }
  }

  throw new WithdrawalDomainError(
    'RECONCILE_REQUIRED',
    'Settlement requires an evidence-backed confirmed attempt (INTENDED_PAYOUT_PROVEN)',
    { details: { withdrawalId: input.withdrawalId } },
  );
}

/**
 * Stamp settled_at only for the exact confirmed attempt. Never broad-update by
 * broadcast_submitted_at. Idempotent when already stamped.
 */
async function stampSettledConfirmedAttempt(
  client: PoolClient,
  input: { readonly withdrawalId: string; readonly attemptId: string },
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE withdrawal_attempts
     SET settled_at = COALESCE(settled_at, now()),
         updated_at = now()
     WHERE id = $1::uuid
       AND withdrawal_id = $2::uuid
     RETURNING id::text`,
    [input.attemptId, input.withdrawalId],
  );
  if (result.rows[0] === undefined) {
    throw new WithdrawalDomainError(
      'RECONCILE_REQUIRED',
      'Confirmed attempt missing during settlement stamp',
      { details: input },
    );
  }
}
