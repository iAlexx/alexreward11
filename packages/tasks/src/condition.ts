import { MissionDomainError } from './errors.js';
import { parseMissionEligibilityPolicy } from './eligibility-policy.js';
import type { MissionConditionType, MissionVersion } from './mission-version.js';

/**
 * Structural validation for a mission version's condition/target/eligibility.
 * Does not evaluate runtime eligibility.
 */
export function validateMissionVersionStructure(version: {
  readonly conditionType: MissionConditionType;
  readonly target: number;
  readonly eligibilityPolicy: unknown;
}): void {
  if (!Number.isInteger(version.target) || version.target <= 0) {
    throw new MissionDomainError(
      'MISSION_INTEGRITY',
      'mission target must be a positive integer',
      { target: version.target },
    );
  }

  const eligibility = parseMissionEligibilityPolicy(version.eligibilityPolicy);

  switch (version.conditionType) {
    case 'DAILY_LOGIN':
      if (version.target !== 1) {
        throw new MissionDomainError(
          'MISSION_INTEGRITY',
          'DAILY_LOGIN target must equal 1',
          { target: version.target },
        );
      }
      return;
    case 'VALID_AD_COUNT':
      return;
    case 'STREAK_MILESTONE':
      if (eligibility.streak === null) {
        throw new MissionDomainError(
          'MISSION_ELIGIBILITY_POLICY_INVALID',
          'STREAK_MILESTONE requires explicit typed streak policy',
        );
      }
      return;
    case 'REFERRAL_ACTIVATION_COUNT':
    case 'MEMBERSHIP_REQUIRED':
    case 'TIME_WINDOW':
    case 'COUNTRY_GROUP':
      // Vocabulary retained; contribution path rejects unsupported evaluation.
      return;
    default: {
      const exhaustive: never = version.conditionType;
      throw new MissionDomainError(
        'MISSION_CONDITION_UNSUPPORTED',
        `unsupported condition type ${String(exhaustive)}`,
      );
    }
  }
}

export type MissionProgressSourceKind =
  | 'AUTHENTICATED_LOGIN_DAY'
  | 'REWARD_EVENT'
  | 'STREAK_DAY'
  | 'REFERRAL_EDGE';

/** Map condition → required contribution source_kind. */
export function requiredSourceKindForCondition(
  conditionType: MissionConditionType,
): MissionProgressSourceKind {
  switch (conditionType) {
    case 'DAILY_LOGIN':
      return 'AUTHENTICATED_LOGIN_DAY';
    case 'VALID_AD_COUNT':
      return 'REWARD_EVENT';
    case 'STREAK_MILESTONE':
      return 'STREAK_DAY';
    case 'REFERRAL_ACTIVATION_COUNT':
      return 'REFERRAL_EDGE';
    case 'MEMBERSHIP_REQUIRED':
    case 'TIME_WINDOW':
    case 'COUNTRY_GROUP':
      throw new MissionDomainError(
        'MISSION_CONDITION_UNSUPPORTED',
        `condition ${conditionType} is not a Phase16 progress-contribution type`,
        { conditionType },
      );
    default: {
      const exhaustive: never = conditionType;
      throw new MissionDomainError(
        'MISSION_CONDITION_UNSUPPORTED',
        `unsupported condition type ${String(exhaustive)}`,
      );
    }
  }
}

export function assertSourceMatchesCondition(
  version: Pick<MissionVersion, 'conditionType'>,
  sourceKind: MissionProgressSourceKind,
): void {
  const required = requiredSourceKindForCondition(version.conditionType);
  if (sourceKind !== required) {
    throw new MissionDomainError(
      'MISSION_SOURCE_MISMATCH',
      `sourceKind ${sourceKind} does not match condition ${version.conditionType}`,
      { sourceKind, conditionType: version.conditionType, required },
    );
  }
}
