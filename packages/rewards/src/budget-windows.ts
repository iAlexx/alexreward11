import { RewardDomainError } from './errors.js';

export type BudgetPeriodGranularity = 'HOUR' | 'UTC_DAY' | 'UTC_MONTH';

export interface CanonicalUtcWindow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly granularity: BudgetPeriodGranularity;
}

export function utcHourContaining(asOf: Date = new Date()): CanonicalUtcWindow {
  const periodStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), asOf.getUTCHours()),
  );
  return {
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 3_600_000),
    granularity: 'HOUR',
  };
}

export function utcDayContaining(asOf: Date = new Date()): CanonicalUtcWindow {
  const periodStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  return {
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 86_400_000),
    granularity: 'UTC_DAY',
  };
}

export function utcMonthContaining(asOf: Date = new Date()): CanonicalUtcWindow {
  const periodStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd, granularity: 'UTC_MONTH' };
}

function isExactUtcHourBoundary(start: Date, end: Date): boolean {
  return (
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0 &&
    end.getTime() === start.getTime() + 3_600_000
  );
}

function isExactUtcDayBoundary(start: Date, end: Date): boolean {
  return (
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0 &&
    end.getTime() === start.getTime() + 86_400_000
  );
}

function isExactUtcMonthBoundary(start: Date, end: Date): boolean {
  if (
    start.getUTCDate() !== 1 ||
    start.getUTCHours() !== 0 ||
    start.getUTCMinutes() !== 0 ||
    start.getUTCSeconds() !== 0 ||
    start.getUTCMilliseconds() !== 0
  ) {
    return false;
  }
  const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return end.getTime() === expectedEnd.getTime();
}

/**
 * Fail closed when granularity does not match a canonical UTC window.
 */
export function assertCanonicalBudgetWindow(
  granularity: string,
  periodStart: Date,
  periodEnd: Date,
  label = 'budget period',
): void {
  let ok = false;
  if (granularity === 'HOUR') {
    ok = isExactUtcHourBoundary(periodStart, periodEnd);
  } else if (granularity === 'UTC_DAY') {
    ok = isExactUtcDayBoundary(periodStart, periodEnd);
  } else if (granularity === 'UTC_MONTH') {
    ok = isExactUtcMonthBoundary(periodStart, periodEnd);
  }
  if (!ok) {
    throw new RewardDomainError(
      'BUDGET_SCOPE_MISMATCH',
      `${label} granularity window is not a canonical UTC ${granularity} period`,
      {
        details: {
          granularity,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
      },
    );
  }
}

/** Phase 5 base reward quotes may only be authorized by these scope types. */
export const PHASE5_BASE_BUDGET_SCOPES = new Set([
  'GLOBAL',
  'PROVIDER',
  'COUNTRY_GROUP',
  'REWARD_RULE',
]);
