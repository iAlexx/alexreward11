export { RewardDomainError } from './errors.js';
export type { RewardErrorCode } from './errors.js';

export {
  computeRawRewardAtomic,
  clampRewardAtomic,
  computeQuotedRewardAtomic,
  computeMembershipBonusAtomic,
  computeReferralBonusAtomic,
} from './arithmetic.js';

export { isPool, withLedgerTransaction } from './db.js';
export type { LedgerDb } from './db.js';

export {
  createRewardRuleVersion,
  activateRewardRuleVersion,
  supersedeRewardRuleVersion,
  resolveRewardRule,
} from './rules.js';

export {
  createRewardBudgetPeriod,
  reserveRewardBudget,
  consumeRewardBudgetReservation,
  releaseRewardBudgetReservation,
  lockRewardBudgetPeriodsInOrder,
} from './budgets.js';
export type { RewardBudgetPeriodRecord, RewardBudgetReservationRecord } from './budgets.js';

export {
  createMembershipBonusBudgetPeriod,
  reserveMembershipBonusBudget,
  consumeMembershipBonusBudgetReservation,
  releaseMembershipBonusBudgetReservation,
  lockMembershipBonusBudgetPeriodsInOrder,
} from './bonus-budgets.js';
export type {
  MembershipBonusBudgetPeriodRecord,
  MembershipBonusBudgetReservationRecord,
} from './bonus-budgets.js';

export {
  evaluateNewQuoteGuardrails,
  assertNewQuotesAllowed,
  isMembershipBonusPaused,
  requireBonusUnavailablePolicy,
} from './guardrails.js';

export { createRewardQuote, expireRewardQuote } from './quotes.js';

export {
  createSimulatedRewardSourceIdentity,
  completeSimulatedRewardSource,
  ensureSimulatedRewardProvider,
  membershipBonusSourceIdFromBase,
} from './simulated.js';

export { issueSimulatedReward } from './issuance.js';
export { issueAdReward } from './issue-ad.js';
export {
  issueReferralReward,
  referralBonusSourceIdFromOrigin,
} from './issue-referral.js';
export type {
  IssueReferralRewardCommand,
  IssueReferralRewardResult,
  ReferralIssuanceKind,
} from './issue-referral.js';
export {
  issueMissionReward,
  issueMissionRewardOnClient,
  missionRewardSourceIdFromClaim,
} from './issue-mission.js';
export type {
  IssueMissionRewardCommand,
  IssueMissionRewardResult,
  MissionIssuanceKind,
} from './issue-mission.js';
export { reverseRewardEvent, reverseRewardEventOnClient } from './reverse-reward.js';
export type {
  ReverseRewardEventCommand,
  ReverseRewardEventResult,
} from './reverse-reward.js';
export { matureRewardEvent } from './maturity.js';
export {
  processDueReferralMaturityBatch,
  processReferralIssuanceBatch,
} from './referral-maintenance.js';
export {
  processDueMissionRewardMaturityBatch,
  processPendingMissionRewardClaimsBatch,
} from './mission-maintenance.js';
export type {
  MissionIssuanceBatchItem,
  MissionMaturityBatchItem,
  ProcessDueMissionRewardMaturityBatchOptions,
  ProcessDueMissionRewardMaturityBatchResult,
  ProcessPendingMissionRewardClaimsBatchOptions,
  ProcessPendingMissionRewardClaimsBatchResult,
} from './mission-maintenance.js';
export type {
  ProcessDueReferralMaturityBatchOptions,
  ProcessDueReferralMaturityBatchResult,
  ProcessReferralIssuanceBatchOptions,
  ProcessReferralIssuanceBatchResult,
  ReferralIssuanceBatchItem,
  ReferralMaturityBatchItem,
} from './referral-maintenance.js';

export {
  createExposureLimitVersion,
  createBenefitRuleVersion,
  setFeatureFlagEnabled,
  bindPlanEntitlement,
} from './config.js';

export { insertOutboxEvent } from './outbox.js';

export { readUserLifetimeEarned } from './user-read.js';
export type { ReadUserLifetimeEarnedInput, UserLifetimeEarned } from './user-read.js';

export type {
  MembershipBonusUnavailablePolicy,
  RewardSourceType,
  RewardQuoteStatus,
  RewardEventState,
  RuleVersionStatus,
  BudgetReservationState,
  EnvironmentName,
  AppliedEconomicsFormulaInputs,
  AppliedEconomics,
  RewardRuleRecord,
  ResolveRewardRuleContext,
  CreateRewardRuleVersionCommand,
  CreateRewardBudgetPeriodCommand,
  CreateMembershipBonusBudgetPeriodCommand,
  CreateRewardQuoteCommand,
  RewardQuoteResult,
  SimulatedSourceIdentity,
  CompleteSimulatedSourceCommand,
  IssueSimulatedRewardCommand,
  IssueAdRewardCommand,
  IssuedRewardResult,
  MatureRewardEventCommand,
  MatureRewardEventResult,
  CreateExposureLimitVersionCommand,
  CreateBenefitRuleVersionCommand,
  GuardrailEvaluation,
  PendingExposureReservation,
  EvaluatedExposureLimitSnapshot,
} from './types.js';

export {
  SIMULATED_REWARD_SOURCE_CODE,
  DEFAULT_PENDING_HOLD_SECONDS,
  ELIGIBLE_REWARD_BONUS_CODE,
} from './types.js';

export {
  validateBaseBudgetPeriod,
  resolveApplicableBonusBudgetPeriods,
} from './budget-authority.js';

export {
  assertCanonicalBudgetWindow,
  utcDayContaining,
  utcHourContaining,
  utcMonthContaining,
  PHASE5_BASE_BUDGET_SCOPES,
} from './budget-windows.js';

export {
  releaseExposureReservationsForQuote,
  consumeExposureReservationsForQuote,
} from './exposure.js';
