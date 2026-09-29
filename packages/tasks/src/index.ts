/**
 * Phase 16 mission package.
 *
 * Step 2: idempotent progress contribution engine (no monetary issuance).
 */

export { MissionDomainError, type MissionErrorCode } from './errors.js';
export {
  getMissionVersionById,
  mapMissionDefinitionRow,
  mapMissionVersionRow,
  resolveActiveMissionVersion,
  resolveActiveMissionVersionForEvaluation,
  type MissionConditionType,
  type MissionDefinition,
  type MissionDefinitionStatus,
  type MissionResetPolicy,
  type MissionVersion,
  type MissionVersionStatus,
  type ResolveActiveMissionVersionOptions,
  type ResolvedMissionVersion,
} from './mission-version.js';
export {
  formatUtcDayKey,
  formatUtcMonthKey,
  resolveMissionPeriod,
  utcDayWindow,
  utcMonthWindow,
  type MissionPeriod,
} from './period.js';
export {
  parseMissionEligibilityPolicy,
  type MissionEligibilityPolicy,
  type MissionStreakPolicy,
  type MissionStreakSource,
} from './eligibility-policy.js';
export {
  assertSourceMatchesCondition,
  requiredSourceKindForCondition,
  validateMissionVersionStructure,
  type MissionProgressSourceKind,
} from './condition.js';
export {
  contributeMissionProgress,
  loadMissionVersionForContribution,
  type ContributeMissionProgressInput,
  type ContributeMissionProgressResult,
} from './contribute.js';
export { insertMissionOutboxEvent, type InsertMissionOutboxEventInput } from './outbox.js';
