import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { assertCanonicalBudgetWindow } from './budget-windows.js';
import { RewardDomainError } from './errors.js';
import type { CreateRewardBudgetPeriodCommand } from './types.js';

export interface RewardBudgetPeriodRecord {
  readonly id: string;
  readonly budgetAtomic: string;
  readonly reservedAtomic: string;
  readonly consumedAtomic: string;
  readonly releasedAtomic: string;
  readonly status: string;
}

export interface RewardBudgetReservationRecord {
  readonly id: string;
  readonly rewardQuoteId: string;
  readonly budgetPeriodId: string;
  readonly amountAtomic: string;
  readonly state: string;
}

function parsePositive(value: bigint | string, label: string): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value.trim());
  if (amount <= 0n) {
    throw new RewardDomainError('VALIDATION', `${label} must be greater than zero`);
  }
  return amountAtomicToString(amount);
}

export async function createRewardBudgetPeriod(
  client: PoolClient,
  command: CreateRewardBudgetPeriodCommand,
): Promise<RewardBudgetPeriodRecord> {
  const budgetAtomic = parsePositive(command.budgetAtomic, 'budgetAtomic');
  assertCanonicalBudgetWindow(
    command.granularity,
    command.periodStart,
    command.periodEnd,
    'reward budget period',
  );
  const result = await client.query<{
    id: string;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    released_atomic: string;
    status: string;
  }>(
    `INSERT INTO reward_budget_periods (
       scope_type, scope_reference_id, country_group, asset_id, granularity,
       period_start, period_end, budget_atomic, rule_version, status
     ) VALUES (
       $1::budget_scope_type, $2::uuid, $3, $4::uuid, $5::budget_period_granularity,
       $6::timestamptz, $7::timestamptz, $8::bigint, $9, 'ACTIVE'
     )
     RETURNING id, budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
               consumed_atomic::text AS consumed_atomic, released_atomic::text AS released_atomic, status`,
    [
      command.scopeType,
      command.scopeReferenceId ?? null,
      command.countryGroup ?? null,
      command.assetId,
      command.granularity,
      command.periodStart.toISOString(),
      command.periodEnd.toISOString(),
      budgetAtomic,
      command.ruleVersion ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new RewardDomainError('INTERNAL', 'budget period insert failed');
  return {
    id: row.id,
    budgetAtomic: row.budget_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
    releasedAtomic: row.released_atomic,
    status: row.status,
  };
}

async function lockBudgetPeriod(
  client: PoolClient,
  budgetPeriodId: string,
): Promise<{
  id: string;
  budget_atomic: string;
  reserved_atomic: string;
  consumed_atomic: string;
  status: string;
}> {
  const result = await client.query<{
    id: string;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    status: string;
  }>(
    `SELECT id, budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
            consumed_atomic::text AS consumed_atomic, status
     FROM reward_budget_periods
     WHERE id = $1
     FOR UPDATE`,
    [budgetPeriodId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'reward budget period not found', {
      details: { budgetPeriodId },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new RewardDomainError('BUDGET_EXHAUSTED', 'reward budget period is not ACTIVE', {
      details: { budgetPeriodId, status: row.status },
    });
  }
  return row;
}

/** Reserve base reward budget for a quote. Amount is base_amount_atomic only. */
export async function reserveRewardBudget(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly rewardQuoteId: string;
    readonly amountAtomic: bigint | string;
  },
): Promise<RewardBudgetReservationRecord> {
  const amount = parsePositive(input.amountAtomic, 'amountAtomic');
  const period = await lockBudgetPeriod(client, input.budgetPeriodId);
  const remaining =
    BigInt(period.budget_atomic) - BigInt(period.reserved_atomic) - BigInt(period.consumed_atomic);
  if (BigInt(amount) > remaining) {
    throw new RewardDomainError('BUDGET_EXHAUSTED', 'insufficient reward budget remaining', {
      details: {
        budgetPeriodId: input.budgetPeriodId,
        remaining: remaining.toString(10),
        requested: amount,
      },
    });
  }

  await client.query(
    `UPDATE reward_budget_periods
     SET reserved_atomic = reserved_atomic + $2::bigint, updated_at = now()
     WHERE id = $1`,
    [input.budgetPeriodId, amount],
  );

  const inserted = await client.query<{
    id: string;
    reward_quote_id: string;
    budget_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `INSERT INTO reward_budget_reservations (
       reward_quote_id, budget_period_id, amount_atomic, state
     ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'ACTIVE')
     RETURNING id, reward_quote_id, budget_period_id, amount_atomic::text AS amount_atomic, state`,
    [input.rewardQuoteId, input.budgetPeriodId, amount],
  );
  const row = inserted.rows[0];
  if (row === undefined)
    throw new RewardDomainError('INTERNAL', 'budget reservation insert failed');
  return {
    id: row.id,
    rewardQuoteId: row.reward_quote_id,
    budgetPeriodId: row.budget_period_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
  };
}

export async function consumeRewardBudgetReservation(
  client: PoolClient,
  reservationId: string,
): Promise<RewardBudgetReservationRecord> {
  const locked = await client.query<{
    id: string;
    reward_quote_id: string;
    budget_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `SELECT id, reward_quote_id, budget_period_id, amount_atomic::text AS amount_atomic, state
     FROM reward_budget_reservations
     WHERE id = $1
     FOR UPDATE`,
    [reservationId],
  );
  const reservation = locked.rows[0];
  if (reservation === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'reward budget reservation not found');
  }
  if (reservation.state === 'CONSUMED') {
    return {
      id: reservation.id,
      rewardQuoteId: reservation.reward_quote_id,
      budgetPeriodId: reservation.budget_period_id,
      amountAtomic: reservation.amount_atomic,
      state: reservation.state,
    };
  }
  if (reservation.state !== 'ACTIVE') {
    throw new RewardDomainError('VALIDATION', 'only ACTIVE reward reservations can be consumed', {
      details: { reservationId, state: reservation.state },
    });
  }

  await lockBudgetPeriod(client, reservation.budget_period_id);
  await client.query(
    `UPDATE reward_budget_periods
     SET reserved_atomic = reserved_atomic - $2::bigint,
         consumed_atomic = consumed_atomic + $2::bigint,
         updated_at = now()
     WHERE id = $1`,
    [reservation.budget_period_id, reservation.amount_atomic],
  );
  const updated = await client.query<{
    id: string;
    reward_quote_id: string;
    budget_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `UPDATE reward_budget_reservations
     SET state = 'CONSUMED', consumed_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, reward_quote_id, budget_period_id, amount_atomic::text AS amount_atomic, state`,
    [reservationId],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new RewardDomainError('INTERNAL', 'consume reservation failed');
  return {
    id: row.id,
    rewardQuoteId: row.reward_quote_id,
    budgetPeriodId: row.budget_period_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
  };
}

export async function releaseRewardBudgetReservation(
  client: PoolClient,
  reservationId: string,
): Promise<RewardBudgetReservationRecord> {
  const locked = await client.query<{
    id: string;
    reward_quote_id: string;
    budget_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `SELECT id, reward_quote_id, budget_period_id, amount_atomic::text AS amount_atomic, state
     FROM reward_budget_reservations
     WHERE id = $1
     FOR UPDATE`,
    [reservationId],
  );
  const reservation = locked.rows[0];
  if (reservation === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'reward budget reservation not found');
  }
  if (reservation.state === 'RELEASED') {
    return {
      id: reservation.id,
      rewardQuoteId: reservation.reward_quote_id,
      budgetPeriodId: reservation.budget_period_id,
      amountAtomic: reservation.amount_atomic,
      state: reservation.state,
    };
  }
  if (reservation.state !== 'ACTIVE') {
    throw new RewardDomainError('VALIDATION', 'only ACTIVE reward reservations can be released', {
      details: { reservationId, state: reservation.state },
    });
  }

  await lockBudgetPeriod(client, reservation.budget_period_id);
  await client.query(
    `UPDATE reward_budget_periods
     SET reserved_atomic = reserved_atomic - $2::bigint,
         released_atomic = released_atomic + $2::bigint,
         updated_at = now()
     WHERE id = $1`,
    [reservation.budget_period_id, reservation.amount_atomic],
  );
  const updated = await client.query<{
    id: string;
    reward_quote_id: string;
    budget_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `UPDATE reward_budget_reservations
     SET state = 'RELEASED', released_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, reward_quote_id, budget_period_id, amount_atomic::text AS amount_atomic, state`,
    [reservationId],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new RewardDomainError('INTERNAL', 'release reservation failed');
  return {
    id: row.id,
    rewardQuoteId: row.reward_quote_id,
    budgetPeriodId: row.budget_period_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
  };
}

/**
 * Lock multiple reward budget periods in deterministic id order (FOR UPDATE).
 */
export async function lockRewardBudgetPeriodsInOrder(
  client: PoolClient,
  budgetPeriodIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(budgetPeriodIds)].sort();
  if (unique.length === 0) return;
  await client.query(
    `SELECT id FROM reward_budget_periods WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [unique],
  );
}
