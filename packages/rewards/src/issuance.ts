import type { PoolClient } from 'pg';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
  type LedgerDb,
} from '@alex-rewards/ledger';

import { consumeMembershipBonusBudgetReservation } from './bonus-budgets.js';
import { consumeRewardBudgetReservation } from './budgets.js';
import { RewardDomainError } from './errors.js';
import { consumeExposureReservationsForQuote } from './exposure.js';
import { insertOutboxEvent } from './outbox.js';
import { membershipBonusSourceIdFromBase } from './simulated.js';
import {
  DEFAULT_PENDING_HOLD_SECONDS,
  type IssueSimulatedRewardCommand,
  type IssuedRewardResult,
} from './types.js';

type LoadedQuote = {
  id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  asset_id: string;
  reward_rule_id: string;
  rule_version: number;
  base_amount_atomic: string;
  membership_bonus_amount_atomic: string;
  status: string;
  source_started_at: Date | null;
  expires_at: Date;
  pending_hold_seconds: number;
};

type LoadQuoteResult =
  | { readonly kind: 'open'; readonly quote: LoadedQuote }
  | { readonly kind: 'recovered'; readonly result: IssuedRewardResult };

async function loadOpenQuoteForIssuance(
  client: PoolClient,
  quoteId: string,
  userId: string,
  asOf: Date,
): Promise<LoadQuoteResult> {
  const result = await client.query<LoadedQuote>(
    `SELECT q.id, q.user_id, q.source_type::text AS source_type, q.source_id, q.asset_id,
            q.reward_rule_id, q.rule_version,
            q.base_amount_atomic::text AS base_amount_atomic,
            q.membership_bonus_amount_atomic::text AS membership_bonus_amount_atomic,
            q.status::text AS status, q.source_started_at, q.expires_at,
            r.pending_hold_seconds
     FROM reward_quotes q
     JOIN reward_rules r ON r.id = q.reward_rule_id
     WHERE q.id = $1
     FOR UPDATE OF q`,
    [quoteId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('QUOTE_NOT_FOUND', 'reward quote not found', {
      details: { quoteId },
    });
  }
  if (row.user_id !== userId) {
    throw new RewardDomainError('SOURCE_INVALID', 'quote does not belong to user');
  }
  if (row.status === 'CONSUMED') {
    const existing = await client.query<{
      id: string;
      ledger_transaction_id: string | null;
      amount_atomic: string;
      pending_until: Date | null;
    }>(
      `SELECT id, ledger_transaction_id, amount_atomic::text AS amount_atomic, pending_until
       FROM reward_events WHERE reward_quote_id = $1`,
      [quoteId],
    );
    const base = existing.rows[0];
    if (base !== undefined && base.ledger_transaction_id !== null) {
      const bonus = await client.query<{
        id: string;
        ledger_transaction_id: string | null;
        amount_atomic: string;
      }>(
        `SELECT id, ledger_transaction_id, amount_atomic::text AS amount_atomic
         FROM reward_events
         WHERE source_type = 'MEMBERSHIP_BONUS'
           AND source_id = $1::uuid`,
        [membershipBonusSourceIdFromBase(base.id)],
      );
      const bonusRow = bonus.rows[0];
      return {
        kind: 'recovered',
        result: {
          baseRewardEventId: base.id,
          bonusRewardEventId: bonusRow?.id ?? null,
          baseLedgerTransactionId: base.ledger_transaction_id,
          bonusLedgerTransactionId: bonusRow?.ledger_transaction_id ?? null,
          baseAmountAtomic: base.amount_atomic,
          membershipBonusAmountAtomic: bonusRow?.amount_atomic ?? '0',
          pendingUntil: (base.pending_until ?? new Date()).toISOString(),
          quoteId,
        },
      };
    }
    throw new RewardDomainError(
      'ISSUANCE_CONFLICT',
      'quote already consumed without recoverable event',
      { details: { quoteId } },
    );
  }
  if (row.status !== 'OPEN') {
    throw new RewardDomainError('QUOTE_NOT_OPEN', 'quote is not OPEN for issuance', {
      details: { status: row.status },
    });
  }
  if (row.source_type !== 'PROMOTION') {
    throw new RewardDomainError(
      'SOURCE_INVALID',
      'Phase 5 issuance supports simulated PROMOTION sources only',
    );
  }
  if (row.source_started_at === null) {
    throw new RewardDomainError(
      'SOURCE_NOT_READY',
      'simulated source must be started/completed before issuance',
    );
  }
  // After expires_at, issuance is allowed only if authoritative start was on/before expiry.
  if (
    asOf.getTime() > row.expires_at.getTime() &&
    !(row.source_started_at !== null && row.source_started_at.getTime() <= row.expires_at.getTime())
  ) {
    throw new RewardDomainError('QUOTE_EXPIRED', 'quote expired without a timely source start', {
      details: {
        expiresAt: row.expires_at.toISOString(),
        sourceStartedAt: row.source_started_at.toISOString(),
        asOf: asOf.toISOString(),
      },
    });
  }
  return { kind: 'open', quote: row };
}

/**
 * Issue simulated reward: base + optional membership bonus in ONE outer transaction.
 * Base reservation amount only; bonus uses membership_bonus_budget_reservations.
 * Bonus reward_event.reward_quote_id is NULL (UNIQUE(reward_quote_id) allows one quote link).
 */
export async function issueSimulatedReward(
  db: LedgerDb,
  command: IssueSimulatedRewardCommand,
): Promise<IssuedRewardResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = command.asOf ?? new Date();
    const loaded = await loadOpenQuoteForIssuance(client, command.quoteId, command.userId, asOf);
    if (loaded.kind === 'recovered') {
      return loaded.result;
    }
    const quote = loaded.quote;

    const pendingHoldSeconds =
      quote.pending_hold_seconds > 0 ? quote.pending_hold_seconds : DEFAULT_PENDING_HOLD_SECONDS;
    const pendingUntil = new Date(asOf.getTime() + pendingHoldSeconds * 1000);

    const baseReservation = await client.query<{ id: string; state: string }>(
      `SELECT id, state::text AS state FROM reward_budget_reservations
       WHERE reward_quote_id = $1 FOR UPDATE`,
      [quote.id],
    );
    const baseReservationRow = baseReservation.rows[0];
    if (baseReservationRow === undefined || baseReservationRow.state !== 'ACTIVE') {
      throw new RewardDomainError('BUDGET_NOT_FOUND', 'active base budget reservation required');
    }

    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId: quote.asset_id,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: quote.asset_id,
      ownerId: quote.user_id,
    });

    const baseLedger = await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'reward-issuance',
      businessReferenceId: quote.id,
      idempotencyScope: 'rewards.issue.simulated',
      idempotencyKey: `${command.idempotencyKey}:base`,
      assetId: quote.asset_id,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: quote.base_amount_atomic,
        },
        {
          ledgerAccountId: pending.id,
          direction: 'CREDIT',
          amountAtomic: quote.base_amount_atomic,
        },
      ],
      metadata: { quoteId: quote.id, sourceType: quote.source_type, sourceId: quote.source_id },
    });

    const baseEvent = await client.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, reward_quote_id, asset_id, amount_atomic,
         state, reward_rule_id, rule_version, ledger_transaction_id, pending_until
       ) VALUES (
         $1::uuid, $2::reward_source_type, $3::uuid, $4::uuid, $5::uuid, $6::bigint,
         'PENDING', $7::uuid, $8, $9::uuid, $10::timestamptz
       )
       RETURNING id`,
      [
        quote.user_id,
        quote.source_type,
        quote.source_id,
        quote.id,
        quote.asset_id,
        quote.base_amount_atomic,
        quote.reward_rule_id,
        quote.rule_version,
        baseLedger.id,
        pendingUntil.toISOString(),
      ],
    );
    const baseRewardEventId = baseEvent.rows[0]?.id;
    if (baseRewardEventId === undefined) {
      throw new RewardDomainError('INTERNAL', 'base reward_event insert failed');
    }

    await client.query(
      `INSERT INTO reward_maturities (reward_event_id, scheduled_for, status, workflow_id)
       VALUES ($1::uuid, $2::timestamptz, 'SCHEDULED', $3)`,
      [baseRewardEventId, pendingUntil.toISOString(), `reward-maturity/${baseRewardEventId}`],
    );

    await consumeRewardBudgetReservation(client, baseReservationRow.id);

    let bonusRewardEventId: string | null = null;
    let bonusLedgerTransactionId: string | null = null;
    const bonusAmount = BigInt(quote.membership_bonus_amount_atomic);

    if (bonusAmount > 0n) {
      const bonusReservations = await client.query<{ id: string; state: string }>(
        `SELECT id, state::text AS state FROM membership_bonus_budget_reservations
         WHERE reward_quote_id = $1
         ORDER BY id
         FOR UPDATE`,
        [quote.id],
      );
      const activeBonus = bonusReservations.rows.filter((r) => r.state === 'ACTIVE');
      if (activeBonus.length === 0) {
        throw new RewardDomainError(
          'BUDGET_NOT_FOUND',
          'active membership bonus reservation required for quoted bonus',
        );
      }

      const bonusExpense = await getOrCreateLedgerAccount(client, {
        accountType: 'MEMBERSHIP_BONUS_EXPENSE',
        assetId: quote.asset_id,
      });

      const bonusSourceId = membershipBonusSourceIdFromBase(baseRewardEventId);
      const bonusLedger = await postLedgerTransaction(client, {
        transactionType: 'MEMBERSHIP_BONUS_ISSUANCE',
        businessReferenceType: 'membership-bonus-issuance',
        businessReferenceId: bonusSourceId,
        idempotencyScope: 'rewards.issue.simulated',
        idempotencyKey: `${command.idempotencyKey}:bonus`,
        assetId: quote.asset_id,
        entries: [
          {
            ledgerAccountId: bonusExpense.id,
            direction: 'DEBIT',
            amountAtomic: quote.membership_bonus_amount_atomic,
          },
          {
            ledgerAccountId: pending.id,
            direction: 'CREDIT',
            amountAtomic: quote.membership_bonus_amount_atomic,
          },
        ],
        metadata: {
          quoteId: quote.id,
          originatingRewardEventId: baseRewardEventId,
        },
      });
      bonusLedgerTransactionId = bonusLedger.id;

      // CRITICAL: reward_events.reward_quote_id is UNIQUE and nullable — bonus must use NULL.
      const bonusEvent = await client.query<{ id: string }>(
        `INSERT INTO reward_events (
           user_id, source_type, source_id, reward_quote_id, asset_id, amount_atomic,
           state, reward_rule_id, rule_version, ledger_transaction_id, pending_until
         ) VALUES (
           $1::uuid, 'MEMBERSHIP_BONUS'::reward_source_type, $2::uuid, NULL, $3::uuid, $4::bigint,
           'PENDING', $5::uuid, $6, $7::uuid, $8::timestamptz
         )
         RETURNING id`,
        [
          quote.user_id,
          bonusSourceId,
          quote.asset_id,
          quote.membership_bonus_amount_atomic,
          quote.reward_rule_id,
          quote.rule_version,
          bonusLedger.id,
          pendingUntil.toISOString(),
        ],
      );
      bonusRewardEventId = bonusEvent.rows[0]?.id ?? null;
      if (bonusRewardEventId === null) {
        throw new RewardDomainError('INTERNAL', 'bonus reward_event insert failed');
      }

      await client.query(
        `INSERT INTO reward_maturities (reward_event_id, scheduled_for, status, workflow_id)
         VALUES ($1::uuid, $2::timestamptz, 'SCHEDULED', $3)`,
        [bonusRewardEventId, pendingUntil.toISOString(), `reward-maturity/${bonusRewardEventId}`],
      );

      for (const bonusReservationRow of activeBonus) {
        await consumeMembershipBonusBudgetReservation(client, {
          reservationId: bonusReservationRow.id,
          originatingRewardEventId: baseRewardEventId,
          bonusRewardEventId,
        });
      }
    }

    await consumeExposureReservationsForQuote(client, quote.id);

    await client.query(
      `UPDATE reward_quotes
       SET status = 'CONSUMED', consumed_at = $2::timestamptz, updated_at = now()
       WHERE id = $1`,
      [quote.id, asOf.toISOString()],
    );

    await insertOutboxEvent(client, {
      aggregateType: 'reward_event',
      aggregateId: baseRewardEventId,
      eventType: 'reward_event.issued',
      dedupeKey: `reward-event-issued/${baseRewardEventId}`,
      payload: {
        baseRewardEventId,
        bonusRewardEventId,
        quoteId: quote.id,
        baseAmountAtomic: quote.base_amount_atomic,
        membershipBonusAmountAtomic: quote.membership_bonus_amount_atomic,
      },
    });

    return {
      baseRewardEventId,
      bonusRewardEventId,
      baseLedgerTransactionId: baseLedger.id,
      bonusLedgerTransactionId,
      baseAmountAtomic: quote.base_amount_atomic,
      membershipBonusAmountAtomic: quote.membership_bonus_amount_atomic,
      pendingUntil: pendingUntil.toISOString(),
      quoteId: quote.id,
    };
  });
}
