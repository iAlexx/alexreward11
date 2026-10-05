import { MissionDomainError } from './errors.js';

export type MissionStreakSource = 'AUTHENTICATED_LOGIN_DAY';

export interface MissionStreakPolicy {
  readonly source: MissionStreakSource;
  readonly timeZone: 'UTC';
  readonly graceDays: number;
}

export interface MissionEligibilityPolicy {
  readonly countryGroup: string | null;
  readonly streak: MissionStreakPolicy | null;
}

const ALLOWED_TOP_KEYS = new Set(['countryGroup', 'streak']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict typed parse of mission_versions.eligibility_policy.
 * Unknown keys rejected. No executable interpretation.
 */
export function parseMissionEligibilityPolicy(raw: unknown): MissionEligibilityPolicy {
  if (raw === null || raw === undefined) {
    return { countryGroup: null, streak: null };
  }
  if (!isPlainObject(raw)) {
    throw new MissionDomainError(
      'MISSION_ELIGIBILITY_POLICY_INVALID',
      'eligibility_policy must be a JSON object',
    );
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        `eligibility_policy unknown key: ${key}`,
        { key },
      );
    }
  }

  let countryGroup: string | null = null;
  if (raw.countryGroup !== undefined) {
    if (typeof raw.countryGroup !== 'string' || raw.countryGroup.trim() === '') {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        'eligibility_policy.countryGroup must be a non-empty string',
      );
    }
    countryGroup = raw.countryGroup.trim();
  }

  let streak: MissionStreakPolicy | null = null;
  if (raw.streak !== undefined) {
    if (!isPlainObject(raw.streak)) {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        'eligibility_policy.streak must be an object',
      );
    }
    const streakKeys = Object.keys(raw.streak);
    for (const key of streakKeys) {
      if (key !== 'source' && key !== 'timeZone' && key !== 'graceDays') {
        throw new MissionDomainError(
          'MISSION_ELIGIBILITY_POLICY_INVALID',
          `eligibility_policy.streak unknown key: ${key}`,
          { key },
        );
      }
    }
    if (raw.streak.source !== 'AUTHENTICATED_LOGIN_DAY') {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        'eligibility_policy.streak.source must be AUTHENTICATED_LOGIN_DAY',
      );
    }
    if (raw.streak.timeZone !== 'UTC') {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        'eligibility_policy.streak.timeZone must be UTC (no other timezone approved)',
      );
    }
    if (
      typeof raw.streak.graceDays !== 'number' ||
      !Number.isInteger(raw.streak.graceDays) ||
      raw.streak.graceDays < 0
    ) {
      throw new MissionDomainError(
        'MISSION_ELIGIBILITY_POLICY_INVALID',
        'eligibility_policy.streak.graceDays must be an explicit non-negative integer',
      );
    }
    streak = {
      source: 'AUTHENTICATED_LOGIN_DAY',
      timeZone: 'UTC',
      graceDays: raw.streak.graceDays,
    };
  }

  return { countryGroup, streak };
}
