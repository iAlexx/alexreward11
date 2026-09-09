export { RewardDomainError } from './errors.js';
export type { RewardErrorCode } from './errors.js';

export {
  computeRawRewardAtomic,
  clampRewardAtomic,
  computeQuotedRewardAtomic,
  computeMembershipBonusAtomic,
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
export { matureRewardEvent } from './maturity.js';

export {
  createExposureLimitVersion,
  createBenefitRuleVersion,
  setFeatureFlagEnabled,
  bindPlanEntitlement,
} from './config.js';

export { insertOutboxEvent } from './outbox.js';

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
