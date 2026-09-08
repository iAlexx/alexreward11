import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
  type LedgerDb,
} from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import { insertOutboxEvent } from './outbox.js';
import type { MatureRewardEventCommand, MatureRewardEventResult } from './types.js';

/**
 * Mature a PENDING reward_event into AVAILABLE.
 * Idempotent and concurrent-safe (row lock + ledger idempotency).
 * Business reference: reward-maturity/{rewardEventId}
 */
export async function matureRewardEvent(
  db: LedgerDb,
  command: MatureRewardEventCommand,
): Promise<MatureRewardEventResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = command.asOf ?? new Date();
    const locked = await client.query<{
      id: string;
      user_id: string;
      asset_id: string;
      amount_atomic: string;
      state: string;
      pending_until: Date | null;
      available_at: Date | null;
      maturity_ledger_transaction_id: string | null;
    }>(
      `SELECT id, user_id, asset_id, amount_atomic::text AS amount_atomic, state::text AS state,
              pending_until, available_at, maturity_ledger_transaction_id
       FROM reward_events
       WHERE id = $1
       FOR UPDATE`,
      [command.rewardEventId],
    );
    const event = locked.rows[0];
    if (event === undefined) {
      throw new RewardDomainError('VALIDATION', 'reward event not found', {
        details: { rewardEventId: command.rewardEventId },
      });
    }

    if (event.state === 'AVAILABLE' && event.maturity_ledger_transaction_id !== null) {
      return {
        rewardEventId: event.id,
        ledgerTransactionId: event.maturity_ledger_transaction_id,
        created: false,
        state: 'AVAILABLE',
        availableAt: (event.available_at ?? asOf).toISOString(),
      };
    }

    if (event.state !== 'PENDING') {
      throw new RewardDomainError('MATURITY_INVALID_STATE', 'reward event is not PENDING', {
        details: { state: event.state },
      });
    }
    if (event.pending_until !== null && event.pending_until.getTime() > asOf.getTime()) {
      throw new RewardDomainError('MATURITY_NOT_DUE', 'reward event pending hold has not elapsed', {
        details: {
          pendingUntil: event.pending_until.toISOString(),
          asOf: asOf.toISOString(),
        },
      });
    }

    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: event.asset_id,
      ownerId: event.user_id,
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId: event.asset_id,
      ownerId: event.user_id,
    });

    const businessReferenceId = event.id;
    const idempotencyKey = command.idempotencyKey ?? `reward-maturity/${event.id}`;

    const ledger = await postLedgerTransaction(client, {
      transactionType: 'REWARD_MATURITY',
      businessReferenceType: 'reward-maturity',
      businessReferenceId,
      idempotencyScope: 'rewards.maturity',
      idempotencyKey,
      assetId: event.asset_id,
      entries: [
        {
          ledgerAccountId: pending.id,
          direction: 'DEBIT',
          amountAtomic: event.amount_atomic,
        },
        {
          ledgerAccountId: available.id,
          direction: 'CREDIT',
          amountAtomic: event.amount_atomic,
        },
      ],
    });

    await client.query(
      `UPDATE reward_events
       SET state = 'AVAILABLE',
           available_at = $2::timestamptz,
           maturity_ledger_transaction_id = $3::uuid,
           updated_at = now()
       WHERE id = $1`,
      [event.id, asOf.toISOString(), ledger.id],
    );

    await client.query(
      `UPDATE reward_maturities
       SET status = 'MATURED', matured_at = $2::timestamptz, updated_at = now()
       WHERE reward_event_id = $1 AND status = 'SCHEDULED'`,
      [event.id, asOf.toISOString()],
    );

    await insertOutboxEvent(client, {
      aggregateType: 'reward_event',
      aggregateId: event.id,
      eventType: 'reward_event.matured',
      dedupeKey: `reward-event-matured/${event.id}`,
      payload: {
        rewardEventId: event.id,
        ledgerTransactionId: ledger.id,
        amountAtomic: event.amount_atomic,
      },
    });

    return {
      rewardEventId: event.id,
      ledgerTransactionId: ledger.id,
      created: ledger.created,
      state: 'AVAILABLE',
      availableAt: asOf.toISOString(),
    };
  });
}
