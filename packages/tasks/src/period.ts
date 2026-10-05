import { MissionDomainError } from './errors.js';
import type { MissionResetPolicy } from './mission-version.js';

export interface MissionPeriod {
  readonly periodKey: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** UTC calendar day window [start, end). */
export function utcDayWindow(asOf: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const periodEnd = new Date(periodStart.getTime() + 86_400_000);
  return { periodStart, periodEnd };
}

/** UTC calendar month window [start, end). */
export function utcMonthWindow(asOf: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

export function formatUtcDayKey(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const m = pad2(asOf.getUTCMonth() + 1);
  const d = pad2(asOf.getUTCDate());
  return `DAY:${y}-${m}-${d}`;
}

export function formatUtcMonthKey(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const m = pad2(asOf.getUTCMonth() + 1);
  return `MONTH:${y}-${m}`;
}

/**
 * Server-authoritative period derivation.
 * WEEKLY fails closed until Owner boundary policy is approved.
 */
export function resolveMissionPeriod(
  resetPolicy: MissionResetPolicy,
  occurredAt: Date,
): MissionPeriod {
  switch (resetPolicy) {
    case 'NONE':
      return { periodKey: 'LIFETIME', periodStart: null, periodEnd: null };
    case 'DAILY': {
      const { periodStart, periodEnd } = utcDayWindow(occurredAt);
      return {
        periodKey: formatUtcDayKey(occurredAt),
        periodStart,
        periodEnd,
      };
    }
    case 'MONTHLY': {
      const { periodStart, periodEnd } = utcMonthWindow(occurredAt);
      return {
        periodKey: formatUtcMonthKey(occurredAt),
        periodStart,
        periodEnd,
      };
    }
    case 'WEEKLY':
      throw new MissionDomainError(
        'MISSION_PERIOD_WEEKLY_NOT_CONFIGURED',
        'WEEKLY mission reset boundary is not Owner-configured',
        { resetPolicy },
      );
    default: {
      const exhaustive: never = resetPolicy;
      throw new MissionDomainError(
        'MISSION_INTEGRITY',
        `unsupported reset policy ${String(exhaustive)}`,
      );
    }
  }
}
