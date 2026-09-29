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
 *
 * Referral bonus issuance is not triggered here — use processReferralIssuanceBatch.
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
      source_type: string;
      pending_until: Date | null;
      available_at: Date | null;
      maturity_ledger_transaction_id: string | null;
    }>(
      `SELECT id, user_id, asset_id, amount_atomic::text AS amount_atomic, state::text AS state,
              source_type::text AS source_type,
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
        state: 'AVAILABLE' as const,
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

    // Referral maturity: require linked referral_reward_events + safe originating reward.
    if (event.source_type === 'REFERRAL') {
      const link = await client.query<{
        source_reward_event_id: string;
        source_state: string;
      }>(
        `SELECT rre.source_reward_event_id,
                src.state::text AS source_state
         FROM referral_reward_events rre
         JOIN reward_events src ON src.id = rre.source_reward_event_id
         WHERE rre.referrer_reward_event_id = $1::uuid
         FOR SHARE OF rre, src`,
        [event.id],
      );
      const referralLink = link.rows[0];
      if (referralLink === undefined) {
        throw new RewardDomainError(
          'MATURITY_INVALID_STATE',
          'REFERRAL reward event missing referral_reward_events link',
          { details: { rewardEventId: event.id } },
        );
      }
      if (referralLink.source_state === 'REVERSED') {
        throw new RewardDomainError(
          'MATURITY_INVALID_STATE',
          'originating reward is REVERSED; referral cannot mature',
          {
            details: {
              rewardEventId: event.id,
              sourceRewardEventId: referralLink.source_reward_event_id,
            },
          },
        );
      }
      if (referralLink.source_state !== 'AVAILABLE') {
        throw new RewardDomainError(
          'MATURITY_INVALID_STATE',
          'originating reward is not AVAILABLE; referral cannot mature',
          {
            details: {
              rewardEventId: event.id,
              sourceState: referralLink.source_state,
            },
          },
        );
      }
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
      state: 'AVAILABLE' as const,
      availableAt: asOf.toISOString(),
    };
  });
}
