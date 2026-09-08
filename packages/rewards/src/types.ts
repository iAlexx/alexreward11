export type MembershipBonusUnavailablePolicy = 'BASE_REWARD_ONLY' | 'BLOCK_QUOTE_BEFORE_START';

export type RewardSourceType =
  'AD' | 'TASK' | 'MISSION' | 'REFERRAL' | 'MEMBERSHIP_BONUS' | 'SUPPORT_ADJUSTMENT' | 'PROMOTION';

export type RewardQuoteStatus = 'OPEN' | 'CONSUMED' | 'CANCELLED' | 'EXPIRED';
export type RewardEventState = 'CREATED' | 'PENDING' | 'AVAILABLE' | 'REVERSED';
export type RuleVersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
export type BudgetReservationState = 'ACTIVE' | 'RELEASED' | 'CONSUMED';
export type EnvironmentName = 'LOCAL' | 'STAGING' | 'PRODUCTION';

export const SIMULATED_REWARD_SOURCE_CODE = 'SIMULATED_REWARD_SOURCE';
export const DEFAULT_PENDING_HOLD_SECONDS = 86_400;
export const ELIGIBLE_REWARD_BONUS_CODE = 'ELIGIBLE_REWARD_BONUS';

export interface AppliedEconomicsFormulaInputs {
  readonly estimatedEcpmAtomic: string | null;
  readonly userShareBps: number | null;
  readonly safetyFactorBps: number | null;
  readonly minRewardAtomic: string | null;
  readonly maxRewardAtomic: string | null;
  readonly fixedRewardAtomic: string | null;
}

/** Snapshot of every ACTIVE exposure limit evaluated for a quote. */
export interface EvaluatedExposureLimitSnapshot {
  readonly id: string;
  readonly ruleVersion: number;
  readonly limitCode: string;
  readonly scopeReferenceId: string | null;
  readonly countryGroup: string | null;
  readonly assetId: string | null;
  readonly limitAtomic: string | null;
  readonly limitBps: number | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly decision: 'ALLOW' | 'BLOCK' | 'OWNER_DECISION_REQUIRED';
  readonly candidateAmountAtomic: string | null;
}

/** Frozen reconstruction evidence stored on reward_quotes.applied_economics. */
export interface AppliedEconomics {
  readonly rewardRuleId: string;
  readonly ruleVersion: number;
  readonly ruleCode: string;
  readonly formulaInputs: AppliedEconomicsFormulaInputs;
  readonly baseAmountAtomic: string;
  readonly membershipBonusAmountAtomic: string;
  readonly membershipId: string | null;
  readonly entitlementRuleVersionId: string | null;
  readonly bonusRuleVersion: number | null;
  readonly bonusBps: number | null;
  readonly budgetPeriodIds: string[];
  readonly bonusBudgetPeriodIds: string[];
  /** IDs of all materially evaluated active financial limits (allowed and blocked). */
  readonly exposureLimitVersionIds: string[];
  readonly evaluatedExposureLimits: EvaluatedExposureLimitSnapshot[];
  readonly bonusUnavailablePolicy: MembershipBonusUnavailablePolicy | null;
  readonly quoteCreatedAt: string;
  readonly sourceType: RewardSourceType;
  readonly sourceId: string;
}

export interface RewardRuleRecord {
  readonly id: string;
  readonly code: string;
  readonly ruleVersion: number;
  readonly sourceType: RewardSourceType;
  readonly providerId: string | null;
  readonly countryGroup: string | null;
  readonly assetId: string;
  readonly userShareBps: number | null;
  readonly safetyFactorBps: number | null;
  readonly estimatedEcpmAtomic: string | null;
  readonly minRewardAtomic: string | null;
  readonly maxRewardAtomic: string | null;
  readonly fixedRewardAtomic: string | null;
  readonly pendingHoldSeconds: number;
  readonly quoteTtlSeconds: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly status: RuleVersionStatus;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface ResolveRewardRuleContext {
  readonly sourceType: RewardSourceType;
  readonly assetId: string;
  readonly providerId?: string | null;
  readonly countryGroup?: string | null;
}

export interface CreateRewardRuleVersionCommand {
  readonly code: string;
  readonly sourceType: RewardSourceType;
  readonly assetId: string;
  readonly providerId?: string | null;
  readonly countryGroup?: string | null;
  readonly userShareBps?: number | null;
  readonly safetyFactorBps?: number | null;
  readonly estimatedEcpmAtomic?: bigint | string | null;
  readonly minRewardAtomic?: bigint | string | null;
  readonly maxRewardAtomic?: bigint | string | null;
  readonly fixedRewardAtomic?: bigint | string | null;
  readonly pendingHoldSeconds?: number;
  readonly quoteTtlSeconds?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly validFrom?: Date;
  readonly reason?: string | null;
  readonly sourceReference?: string | null;
  readonly createdByAdminId?: string | null;
  readonly activate?: boolean;
}

export interface CreateRewardBudgetPeriodCommand {
  readonly scopeType: string;
  readonly assetId: string;
  readonly granularity: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly budgetAtomic: bigint | string;
  readonly scopeReferenceId?: string | null;
  readonly countryGroup?: string | null;
  readonly ruleVersion?: number | null;
}

export interface CreateMembershipBonusBudgetPeriodCommand {
  readonly assetId: string;
  readonly granularity: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly budgetAtomic: bigint | string;
  readonly membershipPlanId?: string | null;
  readonly userId?: string | null;
  readonly perUserCapAtomic?: bigint | string | null;
}

export interface CreateRewardQuoteCommand {
  readonly userId: string;
  readonly assetId: string;
  readonly sourceType: RewardSourceType;
  readonly sourceId: string;
  readonly providerId?: string | null;
  readonly countryGroup?: string | null;
  readonly asOf?: Date;
  readonly environment?: EnvironmentName;
  readonly evaluateMembershipBonus?: boolean;
  readonly bonusUnavailablePolicy?: MembershipBonusUnavailablePolicy | null;
  /** Locator only — all authority fields are validated server-side. */
  readonly budgetPeriodId?: string | null;
  /** Optional locator; engine resolves ALL applicable bonus periods. */
  readonly membershipBonusBudgetPeriodId?: string | null;
}

export interface RewardQuoteResult {
  readonly quoteId: string;
  readonly status: RewardQuoteStatus;
  readonly baseAmountAtomic: string;
  readonly membershipBonusAmountAtomic: string;
  readonly amountAtomic: string;
  readonly rewardRuleId: string;
  readonly ruleVersion: number;
  readonly expiresAt: string;
  readonly membershipId: string | null;
  readonly appliedEconomics: AppliedEconomics;
  readonly baseReservationId: string;
  readonly bonusReservationId: string | null;
  readonly bonusReservationIds: string[];
}

export interface SimulatedSourceIdentity {
  readonly sourceId: string;
  readonly providerId: string;
  readonly providerCode: typeof SIMULATED_REWARD_SOURCE_CODE;
  readonly productionMonetaryStatus: 'BLOCKED';
}

export interface CompleteSimulatedSourceCommand {
  readonly sourceId: string;
  readonly quoteId: string;
  readonly userId: string;
  readonly completedAt?: Date;
}

export interface IssueSimulatedRewardCommand {
  readonly quoteId: string;
  readonly userId: string;
  readonly asOf?: Date;
  readonly idempotencyKey: string;
}

export interface IssuedRewardResult {
  readonly baseRewardEventId: string;
  readonly bonusRewardEventId: string | null;
  readonly baseLedgerTransactionId: string;
  readonly bonusLedgerTransactionId: string | null;
  readonly baseAmountAtomic: string;
  readonly membershipBonusAmountAtomic: string;
  readonly pendingUntil: string;
  readonly quoteId: string;
}

export interface MatureRewardEventCommand {
  readonly rewardEventId: string;
  readonly asOf?: Date;
  readonly idempotencyKey?: string;
}

export interface MatureRewardEventResult {
  readonly rewardEventId: string;
  readonly ledgerTransactionId: string;
  readonly created: boolean;
  readonly state: RewardEventState;
  readonly availableAt: string;
}

export interface CreateExposureLimitVersionCommand {
  readonly limitCode: string;
  readonly environment: EnvironmentName;
  readonly ruleVersion: number;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date | null;
  readonly limitAtomic?: bigint | string | null;
  readonly limitBps?: number | null;
  readonly scopeReferenceId?: string | null;
  readonly countryGroup?: string | null;
  readonly assetId?: string | null;
  readonly reason?: string | null;
  readonly activate?: boolean;
}

export interface CreateBenefitRuleVersionCommand {
  readonly entitlementId: string;
  readonly ruleVersion: number;
  readonly valueBps?: number | null;
  readonly valueBoolean?: boolean | null;
  readonly valueInteger?: bigint | string | null;
  readonly valueAtomic?: bigint | string | null;
  readonly valueEnum?: string | null;
  readonly membershipPlanId?: string | null;
  readonly assetId?: string | null;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date | null;
  readonly reason?: string | null;
  readonly activate?: boolean;
}

export interface PendingExposureReservation {
  readonly exposurePeriodId: string;
  readonly amountAtomic: bigint;
  readonly limitId: string;
  readonly limitCode: string;
}

export interface GuardrailEvaluation {
  readonly blocked: boolean;
  readonly reasons: string[];
  readonly exposureLimitVersionIds: string[];
  readonly evaluatedExposureLimits: EvaluatedExposureLimitSnapshot[];
  readonly pendingExposureReservations: PendingExposureReservation[];
}
