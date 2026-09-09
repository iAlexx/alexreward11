import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { assertCanonicalBudgetWindow } from './budget-windows.js';
import { RewardDomainError } from './errors.js';
import type { CreateMembershipBonusBudgetPeriodCommand } from './types.js';

export interface MembershipBonusBudgetPeriodRecord {
  readonly id: string;
  readonly budgetAtomic: string;
  readonly reservedAtomic: string;
  readonly consumedAtomic: string;
  readonly releasedAtomic: string;
  readonly status: string;
}

export interface MembershipBonusBudgetReservationRecord {
  readonly id: string;
  readonly budgetPeriodId: string;
  readonly userMembershipId: string;
  readonly rewardQuoteId: string | null;
  readonly amountAtomic: string;
  readonly state: string;
  readonly entitlementRuleVersionId: string;
  readonly bonusRuleVersion: number;
  readonly originatingRewardEventId: string | null;
  readonly bonusRewardEventId: string | null;
}

function parsePositive(value: bigint | string, label: string): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value.trim());
  if (amount <= 0n) {
    throw new RewardDomainError('VALIDATION', `${label} must be greater than zero`);
  }
  return amountAtomicToString(amount);
}

export async function createMembershipBonusBudgetPeriod(
  client: PoolClient,
  command: CreateMembershipBonusBudgetPeriodCommand,
): Promise<MembershipBonusBudgetPeriodRecord> {
  const budgetAtomic = parsePositive(command.budgetAtomic, 'budgetAtomic');
  assertCanonicalBudgetWindow(
    command.granularity,
    command.periodStart,
    command.periodEnd,
    'membership bonus budget period',
  );
  const perUserCap =
    command.perUserCapAtomic === undefined || command.perUserCapAtomic === null
      ? null
      : parsePositive(command.perUserCapAtomic, 'perUserCapAtomic');
  const result = await client.query<{
    id: string;
    budget_atomic: string;
    reserved_atomic: string;
    consumed_atomic: string;
    released_atomic: string;
    status: string;
  }>(
    `INSERT INTO membership_bonus_budget_periods (
       membership_plan_id, user_id, asset_id, granularity,
       period_start, period_end, budget_atomic, per_user_cap_atomic, status
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::budget_period_granularity,
       $5::timestamptz, $6::timestamptz, $7::bigint, $8::bigint, 'ACTIVE'
     )
     RETURNING id, budget_atomic::text AS budget_atomic, reserved_atomic::text AS reserved_atomic,
               consumed_atomic::text AS consumed_atomic, released_atomic::text AS released_atomic, status`,
    [
      command.membershipPlanId ?? null,
      command.userId ?? null,
      command.assetId,
      command.granularity,
      command.periodStart.toISOString(),
      command.periodEnd.toISOString(),
      budgetAtomic,
      perUserCap,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('INTERNAL', 'membership bonus budget period insert failed');
  }
  return {
    id: row.id,
    budgetAtomic: row.budget_atomic,
    reservedAtomic: row.reserved_atomic,
    consumedAtomic: row.consumed_atomic,
    releasedAtomic: row.released_atomic,
    status: row.status,
  };
}

async function lockBonusPeriod(
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
     FROM membership_bonus_budget_periods
     WHERE id = $1
     FOR UPDATE`,
    [budgetPeriodId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'membership bonus budget period not found', {
      details: { budgetPeriodId },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new RewardDomainError(
      'BUDGET_EXHAUSTED',
      'membership bonus budget period is not ACTIVE',
      {
        details: { budgetPeriodId, status: row.status },
      },
    );
  }
  return row;
}

export async function reserveMembershipBonusBudget(
  client: PoolClient,
  input: {
    readonly budgetPeriodId: string;
    readonly userMembershipId: string;
    readonly rewardQuoteId: string;
    readonly entitlementRuleVersionId: string;
    readonly bonusRuleVersion: number;
    readonly amountAtomic: bigint | string;
  },
): Promise<MembershipBonusBudgetReservationRecord> {
  const amount = parsePositive(input.amountAtomic, 'amountAtomic');
  const period = await lockBonusPeriod(client, input.budgetPeriodId);
  const remaining =
    BigInt(period.budget_atomic) - BigInt(period.reserved_atomic) - BigInt(period.consumed_atomic);
  if (BigInt(amount) > remaining) {
    throw new RewardDomainError(
      'BUDGET_EXHAUSTED',
      'insufficient membership bonus budget remaining',
      {
        details: {
          budgetPeriodId: input.budgetPeriodId,
          remaining: remaining.toString(10),
          requested: amount,
        },
      },
    );
  }

  await client.query(
    `UPDATE membership_bonus_budget_periods
     SET reserved_atomic = reserved_atomic + $2::bigint, updated_at = now()
     WHERE id = $1`,
    [input.budgetPeriodId, amount],
  );

  const inserted = await client.query<{
    id: string;
    budget_period_id: string;
    user_membership_id: string;
    reward_quote_id: string | null;
    amount_atomic: string;
    state: string;
    entitlement_rule_version_id: string;
    bonus_rule_version: number;
    originating_reward_event_id: string | null;
    bonus_reward_event_id: string | null;
  }>(
    `INSERT INTO membership_bonus_budget_reservations (
       budget_period_id, user_membership_id, reward_quote_id,
       entitlement_rule_version_id, bonus_rule_version, amount_atomic, state
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, 'ACTIVE'
     )
     RETURNING id, budget_period_id, user_membership_id, reward_quote_id,
               amount_atomic::text AS amount_atomic, state, entitlement_rule_version_id,
               bonus_rule_version, originating_reward_event_id, bonus_reward_event_id`,
    [
      input.budgetPeriodId,
      input.userMembershipId,
      input.rewardQuoteId,
      input.entitlementRuleVersionId,
      input.bonusRuleVersion,
      amount,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('INTERNAL', 'membership bonus reservation insert failed');
  }
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    userMembershipId: row.user_membership_id,
    rewardQuoteId: row.reward_quote_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
    entitlementRuleVersionId: row.entitlement_rule_version_id,
    bonusRuleVersion: row.bonus_rule_version,
    originatingRewardEventId: row.originating_reward_event_id,
    bonusRewardEventId: row.bonus_reward_event_id,
  };
}

export async function consumeMembershipBonusBudgetReservation(
  client: PoolClient,
  input: {
    readonly reservationId: string;
    readonly originatingRewardEventId: string;
    readonly bonusRewardEventId: string;
  },
): Promise<MembershipBonusBudgetReservationRecord> {
  const locked = await client.query<{
    id: string;
    budget_period_id: string;
    user_membership_id: string;
    reward_quote_id: string | null;
    amount_atomic: string;
    state: string;
    entitlement_rule_version_id: string;
    bonus_rule_version: number;
    originating_reward_event_id: string | null;
    bonus_reward_event_id: string | null;
  }>(
    `SELECT id, budget_period_id, user_membership_id, reward_quote_id,
            amount_atomic::text AS amount_atomic, state, entitlement_rule_version_id,
            bonus_rule_version, originating_reward_event_id, bonus_reward_event_id
     FROM membership_bonus_budget_reservations
     WHERE id = $1
     FOR UPDATE`,
    [input.reservationId],
  );
  const reservation = locked.rows[0];
  if (reservation === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'membership bonus reservation not found');
  }
  if (reservation.state === 'CONSUMED') {
    return {
      id: reservation.id,
      budgetPeriodId: reservation.budget_period_id,
      userMembershipId: reservation.user_membership_id,
      rewardQuoteId: reservation.reward_quote_id,
      amountAtomic: reservation.amount_atomic,
      state: reservation.state,
      entitlementRuleVersionId: reservation.entitlement_rule_version_id,
      bonusRuleVersion: reservation.bonus_rule_version,
      originatingRewardEventId: reservation.originating_reward_event_id,
      bonusRewardEventId: reservation.bonus_reward_event_id,
    };
  }
  if (reservation.state !== 'ACTIVE') {
    throw new RewardDomainError('VALIDATION', 'only ACTIVE bonus reservations can be consumed', {
      details: { reservationId: input.reservationId, state: reservation.state },
    });
  }

  await lockBonusPeriod(client, reservation.budget_period_id);
  await client.query(
    `UPDATE membership_bonus_budget_periods
     SET reserved_atomic = reserved_atomic - $2::bigint,
         consumed_atomic = consumed_atomic + $2::bigint,
         updated_at = now()
     WHERE id = $1`,
    [reservation.budget_period_id, reservation.amount_atomic],
  );
  const updated = await client.query<{
    id: string;
    budget_period_id: string;
    user_membership_id: string;
    reward_quote_id: string | null;
    amount_atomic: string;
    state: string;
    entitlement_rule_version_id: string;
    bonus_rule_version: number;
    originating_reward_event_id: string | null;
    bonus_reward_event_id: string | null;
  }>(
    `UPDATE membership_bonus_budget_reservations
     SET state = 'CONSUMED',
         consumed_at = now(),
         originating_reward_event_id = $2::uuid,
         bonus_reward_event_id = $3::uuid,
         updated_at = now()
     WHERE id = $1
     RETURNING id, budget_period_id, user_membership_id, reward_quote_id,
               amount_atomic::text AS amount_atomic, state, entitlement_rule_version_id,
               bonus_rule_version, originating_reward_event_id, bonus_reward_event_id`,
    [input.reservationId, input.originatingRewardEventId, input.bonusRewardEventId],
  );
  const row = updated.rows[0];
  if (row === undefined)
    throw new RewardDomainError('INTERNAL', 'consume bonus reservation failed');
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    userMembershipId: row.user_membership_id,
    rewardQuoteId: row.reward_quote_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
    entitlementRuleVersionId: row.entitlement_rule_version_id,
    bonusRuleVersion: row.bonus_rule_version,
    originatingRewardEventId: row.originating_reward_event_id,
    bonusRewardEventId: row.bonus_reward_event_id,
  };
}

export async function releaseMembershipBonusBudgetReservation(
  client: PoolClient,
  reservationId: string,
): Promise<MembershipBonusBudgetReservationRecord> {
  const locked = await client.query<{
    id: string;
    budget_period_id: string;
    user_membership_id: string;
    reward_quote_id: string | null;
    amount_atomic: string;
    state: string;
    entitlement_rule_version_id: string;
    bonus_rule_version: number;
    originating_reward_event_id: string | null;
    bonus_reward_event_id: string | null;
  }>(
    `SELECT id, budget_period_id, user_membership_id, reward_quote_id,
            amount_atomic::text AS amount_atomic, state, entitlement_rule_version_id,
            bonus_rule_version, originating_reward_event_id, bonus_reward_event_id
     FROM membership_bonus_budget_reservations
     WHERE id = $1
     FOR UPDATE`,
    [reservationId],
  );
  const reservation = locked.rows[0];
  if (reservation === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'membership bonus reservation not found');
  }
  if (reservation.state === 'RELEASED') {
    return {
      id: reservation.id,
      budgetPeriodId: reservation.budget_period_id,
      userMembershipId: reservation.user_membership_id,
      rewardQuoteId: reservation.reward_quote_id,
      amountAtomic: reservation.amount_atomic,
      state: reservation.state,
      entitlementRuleVersionId: reservation.entitlement_rule_version_id,
      bonusRuleVersion: reservation.bonus_rule_version,
      originatingRewardEventId: reservation.originating_reward_event_id,
      bonusRewardEventId: reservation.bonus_reward_event_id,
    };
  }
  if (reservation.state !== 'ACTIVE') {
    throw new RewardDomainError('VALIDATION', 'only ACTIVE bonus reservations can be released', {
      details: { reservationId, state: reservation.state },
    });
  }

  await lockBonusPeriod(client, reservation.budget_period_id);
  await client.query(
    `UPDATE membership_bonus_budget_periods
     SET reserved_atomic = reserved_atomic - $2::bigint,
         released_atomic = released_atomic + $2::bigint,
         updated_at = now()
     WHERE id = $1`,
    [reservation.budget_period_id, reservation.amount_atomic],
  );
  const updated = await client.query<{
    id: string;
    budget_period_id: string;
    user_membership_id: string;
    reward_quote_id: string | null;
    amount_atomic: string;
    state: string;
    entitlement_rule_version_id: string;
    bonus_rule_version: number;
    originating_reward_event_id: string | null;
    bonus_reward_event_id: string | null;
  }>(
    `UPDATE membership_bonus_budget_reservations
     SET state = 'RELEASED', released_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, budget_period_id, user_membership_id, reward_quote_id,
               amount_atomic::text AS amount_atomic, state, entitlement_rule_version_id,
               bonus_rule_version, originating_reward_event_id, bonus_reward_event_id`,
    [reservationId],
  );
  const row = updated.rows[0];
  if (row === undefined)
    throw new RewardDomainError('INTERNAL', 'release bonus reservation failed');
  return {
    id: row.id,
    budgetPeriodId: row.budget_period_id,
    userMembershipId: row.user_membership_id,
    rewardQuoteId: row.reward_quote_id,
    amountAtomic: row.amount_atomic,
    state: row.state,
    entitlementRuleVersionId: row.entitlement_rule_version_id,
    bonusRuleVersion: row.bonus_rule_version,
    originatingRewardEventId: row.originating_reward_event_id,
    bonusRewardEventId: row.bonus_reward_event_id,
  };
}

export async function lockMembershipBonusBudgetPeriodsInOrder(
  client: PoolClient,
  budgetPeriodIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(budgetPeriodIds)].sort();
  if (unique.length === 0) return;
  await client.query(
    `SELECT id FROM membership_bonus_budget_periods
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [unique],
  );
}
