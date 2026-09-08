import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';

export type ExposureWindowKind = 'UTC_HOUR' | 'UTC_DAY' | 'UTC_MONTH';

export interface ExposurePeriodWindow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly kind: ExposureWindowKind;
}

export function utcHourWindow(asOf: Date): ExposurePeriodWindow {
  const periodStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), asOf.getUTCHours()),
  );
  const periodEnd = new Date(periodStart.getTime() + 3_600_000);
  return { periodStart, periodEnd, kind: 'UTC_HOUR' };
}

export function utcDayWindow(asOf: Date): ExposurePeriodWindow {
  const periodStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const periodEnd = new Date(periodStart.getTime() + 86_400_000);
  return { periodStart, periodEnd, kind: 'UTC_DAY' };
}

export function utcMonthWindow(asOf: Date): ExposurePeriodWindow {
  const periodStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd, kind: 'UTC_MONTH' };
}

export function windowForLimitCode(limitCode: string, asOf: Date): ExposurePeriodWindow | null {
  switch (limitCode) {
    case 'MAX_GLOBAL_HOURLY_REWARD_EXPENSE':
      return utcHourWindow(asOf);
    case 'MAX_GLOBAL_DAILY_REWARD_EXPENSE':
    case 'MAX_PROVIDER_DAILY_REWARD_EXPENSE':
    case 'MAX_COUNTRY_DAILY_REWARD_EXPENSE':
    case 'MAX_MEMBERSHIP_BONUS_DAILY':
    case 'MAX_REFERRAL_BONUS_DAILY':
    case 'MAX_MISSION_BONUS_DAILY':
      return utcDayWindow(asOf);
    case 'MAX_MEMBERSHIP_BONUS_MONTHLY':
      return utcMonthWindow(asOf);
    default:
      return null;
  }
}

/**
 * Get-or-create the current exposure period row and lock it FOR UPDATE.
 * Concurrent creators use ON CONFLICT then re-select under lock.
 */
export async function lockOrCreateExposurePeriod(
  client: PoolClient,
  input: {
    readonly exposureLimitId: string;
    readonly limitAtomic: bigint;
    readonly window: ExposurePeriodWindow;
  },
): Promise<{
  id: string;
  reserved_atomic: string;
  consumed_atomic: string;
  limit_atomic: string;
}> {
  await client.query(
    `INSERT INTO economic_exposure_periods (
       exposure_limit_id, period_start, period_end, limit_atomic
     ) VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4::bigint)
     ON CONFLICT (exposure_limit_id, period_start) DO NOTHING`,
    [
      input.exposureLimitId,
      input.window.periodStart.toISOString(),
      input.window.periodEnd.toISOString(),
      amountAtomicToString(input.limitAtomic),
    ],
  );

  const locked = await client.query<{
    id: string;
    reserved_atomic: string;
    consumed_atomic: string;
    limit_atomic: string;
  }>(
    `SELECT id, reserved_atomic::text AS reserved_atomic, consumed_atomic::text AS consumed_atomic,
            limit_atomic::text AS limit_atomic
     FROM economic_exposure_periods
     WHERE exposure_limit_id = $1::uuid
       AND period_start = $2::timestamptz
     FOR UPDATE`,
    [input.exposureLimitId, input.window.periodStart.toISOString()],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('INTERNAL', 'economic exposure period lock failed');
  }
  return row;
}

export async function reserveExposureForQuote(
  client: PoolClient,
  input: {
    readonly rewardQuoteId: string;
    readonly exposurePeriodId: string;
    readonly amountAtomic: bigint;
  },
): Promise<{ id: string }> {
  if (input.amountAtomic <= 0n) {
    throw new RewardDomainError('VALIDATION', 'exposure reservation amount must be > 0');
  }
  const amount = amountAtomicToString(input.amountAtomic);

  const period = await client.query<{
    id: string;
    reserved_atomic: string;
    consumed_atomic: string;
    limit_atomic: string;
  }>(
    `SELECT id, reserved_atomic::text AS reserved_atomic, consumed_atomic::text AS consumed_atomic,
            limit_atomic::text AS limit_atomic
     FROM economic_exposure_periods
     WHERE id = $1
     FOR UPDATE`,
    [input.exposurePeriodId],
  );
  const row = period.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('BUDGET_NOT_FOUND', 'economic exposure period not found');
  }
  const remaining =
    BigInt(row.limit_atomic) - BigInt(row.reserved_atomic) - BigInt(row.consumed_atomic);
  if (input.amountAtomic > remaining) {
    throw new RewardDomainError('GUARDRAIL_BLOCKED', 'insufficient economic exposure capacity', {
      details: {
        exposurePeriodId: input.exposurePeriodId,
        remaining: remaining.toString(10),
        requested: amount,
      },
    });
  }

  await client.query(
    `UPDATE economic_exposure_periods
     SET reserved_atomic = reserved_atomic + $2::bigint, updated_at = now()
     WHERE id = $1`,
    [input.exposurePeriodId, amount],
  );

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO economic_exposure_reservations (
       reward_quote_id, exposure_period_id, amount_atomic, state
     ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'ACTIVE')
     RETURNING id`,
    [input.rewardQuoteId, input.exposurePeriodId, amount],
  );
  const reservation = inserted.rows[0];
  if (reservation === undefined) {
    throw new RewardDomainError('INTERNAL', 'economic exposure reservation insert failed');
  }
  return reservation;
}

export async function releaseExposureReservationsForQuote(
  client: PoolClient,
  rewardQuoteId: string,
): Promise<number> {
  const active = await client.query<{
    id: string;
    exposure_period_id: string;
    amount_atomic: string;
  }>(
    `SELECT id, exposure_period_id, amount_atomic::text AS amount_atomic
     FROM economic_exposure_reservations
     WHERE reward_quote_id = $1 AND state = 'ACTIVE'
     ORDER BY id
     FOR UPDATE`,
    [rewardQuoteId],
  );
  let released = 0;
  for (const reservation of active.rows) {
    await client.query(
      `SELECT id FROM economic_exposure_periods WHERE id = $1 FOR UPDATE`,
      [reservation.exposure_period_id],
    );
    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic - $2::bigint,
           released_atomic = released_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1`,
      [reservation.exposure_period_id, reservation.amount_atomic],
    );
    await client.query(
      `UPDATE economic_exposure_reservations
       SET state = 'RELEASED', released_at = now(), updated_at = now()
       WHERE id = $1`,
      [reservation.id],
    );
    released += 1;
  }
  return released;
}

export async function consumeExposureReservationsForQuote(
  client: PoolClient,
  rewardQuoteId: string,
): Promise<number> {
  const active = await client.query<{
    id: string;
    exposure_period_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `SELECT id, exposure_period_id, amount_atomic::text AS amount_atomic, state::text AS state
     FROM economic_exposure_reservations
     WHERE reward_quote_id = $1
     ORDER BY id
     FOR UPDATE`,
    [rewardQuoteId],
  );
  let consumed = 0;
  for (const reservation of active.rows) {
    if (reservation.state === 'CONSUMED') {
      consumed += 1;
      continue;
    }
    if (reservation.state !== 'ACTIVE') {
      throw new RewardDomainError('VALIDATION', 'exposure reservation not ACTIVE for consume', {
        details: { reservationId: reservation.id, state: reservation.state },
      });
    }
    await client.query(
      `SELECT id FROM economic_exposure_periods WHERE id = $1 FOR UPDATE`,
      [reservation.exposure_period_id],
    );
    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic - $2::bigint,
           consumed_atomic = consumed_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1`,
      [reservation.exposure_period_id, reservation.amount_atomic],
    );
    await client.query(
      `UPDATE economic_exposure_reservations
       SET state = 'CONSUMED', consumed_at = now(), updated_at = now()
       WHERE id = $1`,
      [reservation.id],
    );
    consumed += 1;
  }
  return consumed;
}
