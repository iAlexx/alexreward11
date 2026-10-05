/**
 * Phase 15 Step 6 — Reward Engine reversal with referral cascade.
 * Never mutates historical ledger transactions; posts new linked REWARD_REVERSAL rows.
 */
import type { PoolClient } from 'pg';

import {
  LedgerDomainError,
  reverseLedgerTransaction,
  withLedgerTransaction,
  type LedgerDb,
} from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import { insertOutboxEvent } from './outbox.js';

export interface ReverseRewardEventCommand {
  readonly rewardEventId: string;
  readonly reason: string;
  readonly asOf?: Date;
  readonly idempotencyKey?: string;
}

export interface ReverseRewardEventResult {
  readonly rewardEventId: string;
  readonly state: 'REVERSED';
  readonly reversalLedgerTransactionId: string;
  readonly created: boolean;
  readonly cascadedReferralRewardEventIds: readonly string[];
}

async function reverseIssuanceOnClient(
  client: PoolClient,
  input: {
    readonly originalTransactionId: string;
    readonly rewardEventId: string;
    readonly idempotencyKey: string;
    readonly reason: string;
  },
) {
  try {
    return await reverseLedgerTransaction(client, {
      originalTransactionId: input.originalTransactionId,
      transactionType: 'REWARD_REVERSAL',
      businessReferenceType: 'reward-reversal',
      businessReferenceId: input.rewardEventId,
      idempotencyScope: 'rewards.reversal',
      idempotencyKey: input.idempotencyKey,
      metadata: { reason: input.reason, rewardEventId: input.rewardEventId },
    });
  } catch (error) {
    if (error instanceof LedgerDomainError && error.code === 'NEGATIVE_PROTECTED_BALANCE') {
      throw new RewardDomainError(
        'REWARD_REVERSAL_REQUIRES_REVIEW',
        'Reward reversal would create an unsupported negative user balance',
        { cause: error, details: { rewardEventId: input.rewardEventId } },
      );
    }
    throw error;
  }
}

/**
 * Internal client-scoped reversal. Public callers always cascade AD→referral.
 * Cascading REFERRAL reverse uses cascadeReferral=false to avoid recursion.
 */
export async function reverseRewardEventOnClient(
  client: PoolClient,
  command: ReverseRewardEventCommand,
  options: { readonly cascadeReferral: boolean },
): Promise<ReverseRewardEventResult> {
  if (typeof command.reason !== 'string' || command.reason.trim() === '') {
    throw new RewardDomainError('VALIDATION', 'reversal reason is required');
  }

  const asOf = command.asOf ?? new Date();
  const locked = await client.query<{
    id: string;
    user_id: string;
    source_type: string;
    asset_id: string;
    amount_atomic: string;
    state: string;
    ledger_transaction_id: string | null;
    maturity_ledger_transaction_id: string | null;
    reversal_ledger_transaction_id: string | null;
  }>(
    `SELECT id, user_id, source_type::text AS source_type, asset_id,
            amount_atomic::text AS amount_atomic, state::text AS state,
            ledger_transaction_id, maturity_ledger_transaction_id, reversal_ledger_transaction_id
     FROM reward_events
     WHERE id = $1::uuid
     FOR UPDATE`,
    [command.rewardEventId],
  );
  const event = locked.rows[0];
  if (event === undefined) {
    throw new RewardDomainError('VALIDATION', 'reward event not found', {
      details: { rewardEventId: command.rewardEventId },
    });
  }

  if (event.state === 'REVERSED' && event.reversal_ledger_transaction_id !== null) {
    return {
      rewardEventId: event.id,
      state: 'REVERSED',
      reversalLedgerTransactionId: event.reversal_ledger_transaction_id,
      created: false,
      cascadedReferralRewardEventIds: [],
    };
  }

  if (event.state !== 'PENDING' && event.state !== 'AVAILABLE') {
    throw new RewardDomainError(
      'REVERSAL_INVALID_STATE',
      'reward event cannot be reversed from current state',
      { details: { state: event.state } },
    );
  }

  if (event.ledger_transaction_id === null) {
    throw new RewardDomainError(
      'REVERSAL_INVALID_STATE',
      'reward event has no issuance ledger transaction to reverse',
      { details: { rewardEventId: event.id } },
    );
  }

  const baseIdempotency = command.idempotencyKey ?? `reward-reversal/${event.id}`;

  // AVAILABLE with a maturity posting: reverse maturity first (available → pending),
  // then reverse issuance. AVAILABLE without maturity (direct available credit) reverses
  // the issuance transaction only — still fail-closed on negative protected balance.
  if (event.state === 'AVAILABLE' && event.maturity_ledger_transaction_id !== null) {
    await reverseIssuanceOnClient(client, {
      originalTransactionId: event.maturity_ledger_transaction_id,
      rewardEventId: event.id,
      idempotencyKey: `${baseIdempotency}:maturity`,
      reason: command.reason,
    });
  }

  const issuanceReversal = await reverseIssuanceOnClient(client, {
    originalTransactionId: event.ledger_transaction_id,
    rewardEventId: event.id,
    idempotencyKey: `${baseIdempotency}:issuance`,
    reason: command.reason,
  });

  await client.query(
    `UPDATE reward_events
     SET state = 'REVERSED',
         reversed_at = $2::timestamptz,
         reversal_reason = $3,
         reversal_ledger_transaction_id = $4::uuid,
         updated_at = now()
     WHERE id = $1::uuid`,
    [event.id, asOf.toISOString(), command.reason.trim(), issuanceReversal.id],
  );

  await client.query(
    `UPDATE reward_maturities
     SET status = 'CANCELLED', cancelled_at = $2::timestamptz, updated_at = now()
     WHERE reward_event_id = $1::uuid AND status = 'SCHEDULED'`,
    [event.id, asOf.toISOString()],
  );

  await insertOutboxEvent(client, {
    aggregateType: 'reward_event',
    aggregateId: event.id,
    eventType: 'reward_event.reversed',
    dedupeKey: `reward-event-reversed/${event.id}`,
    payload: {
      rewardEventId: event.id,
      reversalLedgerTransactionId: issuanceReversal.id,
      reason: command.reason.trim(),
      priorState: event.state,
    },
  });

  const cascadedReferralRewardEventIds: string[] = [];
  if (options.cascadeReferral && event.source_type === 'AD') {
    const linked = await client.query<{ referrer_reward_event_id: string }>(
      `SELECT referrer_reward_event_id
       FROM referral_reward_events
       WHERE source_reward_event_id = $1::uuid
         AND referrer_reward_event_id IS NOT NULL
       FOR UPDATE`,
      [event.id],
    );
    for (const row of linked.rows) {
      const referralId = row.referrer_reward_event_id;
      const referralState = await client.query<{ state: string }>(
        `SELECT state::text AS state FROM reward_events WHERE id = $1::uuid FOR UPDATE`,
        [referralId],
      );
      const state = referralState.rows[0]?.state;
      if (state === undefined || state === 'REVERSED') {
        continue;
      }
      if (state !== 'PENDING' && state !== 'AVAILABLE') {
        throw new RewardDomainError(
          'REWARD_REVERSAL_REQUIRES_REVIEW',
          'Linked referral reward cannot be safely cascaded',
          { details: { referralRewardEventId: referralId, state } },
        );
      }
      const cascaded = await reverseRewardEventOnClient(
        client,
        {
          rewardEventId: referralId,
          reason: `cascade:${command.reason.trim()}`,
          asOf,
          idempotencyKey: `reward-reversal-cascade/${event.id}/${referralId}`,
        },
        { cascadeReferral: false },
      );
      cascadedReferralRewardEventIds.push(cascaded.rewardEventId);
    }
  }

  return {
    rewardEventId: event.id,
    state: 'REVERSED',
    reversalLedgerTransactionId: issuanceReversal.id,
    created: issuanceReversal.created,
    cascadedReferralRewardEventIds,
  };
}

/**
 * Reverse a reward_event through new linked ledger reversal transaction(s).
 * Public path always cascades unpaid/maturing referral bonuses when this event
 * is an originating AD source.
 */
export async function reverseRewardEvent(
  db: LedgerDb,
  command: ReverseRewardEventCommand,
): Promise<ReverseRewardEventResult> {
  return withLedgerTransaction(db, async (client) =>
    reverseRewardEventOnClient(client, command, { cascadeReferral: true }),
  );
}
