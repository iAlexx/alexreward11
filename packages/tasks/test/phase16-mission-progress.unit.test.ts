import { describe, expect, it } from 'vitest';

import {
  MissionDomainError,
  formatUtcDayKey,
  formatUtcMonthKey,
  parseMissionEligibilityPolicy,
  resolveMissionPeriod,
  validateMissionVersionStructure,
} from '../src/index.js';

describe('Phase 16 Step 2 period + eligibility (unit)', () => {
  it('resolves NONE / DAILY / MONTHLY UTC periods; WEEKLY fail-closed', () => {
    const at = new Date('2026-03-15T18:30:00.000Z');
    expect(resolveMissionPeriod('NONE', at)).toEqual({
      periodKey: 'LIFETIME',
      periodStart: null,
      periodEnd: null,
    });
    const daily = resolveMissionPeriod('DAILY', at);
    expect(daily.periodKey).toBe('DAY:2026-03-15');
    expect(daily.periodStart?.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(daily.periodEnd?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(formatUtcDayKey(at)).toBe('DAY:2026-03-15');

    const monthly = resolveMissionPeriod('MONTHLY', at);
    expect(monthly.periodKey).toBe('MONTH:2026-03');
    expect(monthly.periodStart?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(monthly.periodEnd?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(formatUtcMonthKey(at)).toBe('MONTH:2026-03');

    expect(() => resolveMissionPeriod('WEEKLY', at)).toThrow(
      expect.objectContaining({ code: 'MISSION_PERIOD_WEEKLY_NOT_CONFIGURED' }),
    );
  });

  it('parses empty eligibility; rejects unknown keys; requires explicit streak grace', () => {
    expect(parseMissionEligibilityPolicy({})).toEqual({
      countryGroup: null,
      streak: null,
    });
    expect(parseMissionEligibilityPolicy(null)).toEqual({
      countryGroup: null,
      streak: null,
    });

    expect(() => parseMissionEligibilityPolicy({ foo: 1 })).toThrow(
      expect.objectContaining({ code: 'MISSION_ELIGIBILITY_POLICY_INVALID' }),
    );

    expect(() =>
      parseMissionEligibilityPolicy({
        streak: { source: 'AUTHENTICATED_LOGIN_DAY', timeZone: 'UTC' },
      }),
    ).toThrow(expect.objectContaining({ code: 'MISSION_ELIGIBILITY_POLICY_INVALID' }));

    expect(() =>
      parseMissionEligibilityPolicy({
        streak: {
          source: 'AUTHENTICATED_LOGIN_DAY',
          timeZone: 'America/New_York',
          graceDays: 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'MISSION_ELIGIBILITY_POLICY_INVALID' }));

    expect(
      parseMissionEligibilityPolicy({
        streak: {
          source: 'AUTHENTICATED_LOGIN_DAY',
          timeZone: 'UTC',
          graceDays: 0,
        },
      }),
    ).toEqual({
      countryGroup: null,
      streak: {
        source: 'AUTHENTICATED_LOGIN_DAY',
        timeZone: 'UTC',
        graceDays: 0,
      },
    });
  });

  it('validates DAILY_LOGIN target=1 and STREAK requires streak policy', () => {
    expect(() =>
      validateMissionVersionStructure({
        conditionType: 'DAILY_LOGIN',
        target: 2,
        eligibilityPolicy: {},
      }),
    ).toThrow(MissionDomainError);

    expect(() =>
      validateMissionVersionStructure({
        conditionType: 'STREAK_MILESTONE',
        target: 3,
        eligibilityPolicy: {},
      }),
    ).toThrow(expect.objectContaining({ code: 'MISSION_ELIGIBILITY_POLICY_INVALID' }));

    expect(() =>
      validateMissionVersionStructure({
        conditionType: 'STREAK_MILESTONE',
        target: 3,
        eligibilityPolicy: {
          streak: {
            source: 'AUTHENTICATED_LOGIN_DAY',
            timeZone: 'UTC',
            graceDays: 1,
          },
        },
      }),
    ).not.toThrow();
  });
});
