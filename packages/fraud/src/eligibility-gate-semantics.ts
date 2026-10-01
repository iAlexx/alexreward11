import type { EligibilityActionType } from './eligibility-decision.js';

/**
 * Action-aware ACCOUNT_STATE / FEATURE_FLAG binding semantics for eligibility.
 *
 * Withdrawal cooldown and withdrawal_status are withdrawal-scoped authority.
 * They must not block Earn/mission/task/referral/membership actions by default.
 * FEATURE_FLAG never falls back to an unrelated pause flag.
 */

export type AccountStateClass =
  | 'NON_ACTIVE'
  | 'BLOCKED'
  | 'COOLDOWN'
  | 'RESTRICTED'
  | 'ACTIVE_ALLOWED';

export interface AccountStateSnapshot {
  readonly status: string;
  readonly withdrawalStatus: string;
  readonly withdrawalCooldownUntil: Date | null;
  readonly now: Date;
}

export interface AccountStateClassification {
  readonly stateClass: AccountStateClass;
  readonly eligible: boolean;
  readonly reasonCode: string;
  readonly cooldownActive: boolean;
  /** True when withdrawal_status/cooldown were consulted (WITHDRAWAL_REQUEST only). */
  readonly withdrawalScopedChecksApplied: boolean;
}

export type EligibilityFeatureFlagBinding =
  | {
      readonly kind: 'pause_flag';
      readonly flagKey: 'WITHDRAWAL_REQUESTS_PAUSE' | 'REFERRAL_REWARD_PAUSE';
    }
  | { readonly kind: 'mission_reward_pause' }
  | { readonly kind: 'unsupported' };

/**
 * Classify ACCOUNT_STATE for a specific eligibility action.
 *
 * All actions: require users.status === ACTIVE.
 * WITHDRAWAL_REQUEST only: also enforce withdrawal_status BLOCKED and
 * withdrawal_cooldown_until (wallet-change cooldown is withdrawal-only).
 */
export function classifyAccountStateForAction(
  actionType: EligibilityActionType,
  snapshot: AccountStateSnapshot,
): AccountStateClassification {
  const cooldownActive =
    snapshot.withdrawalCooldownUntil !== null &&
    snapshot.withdrawalCooldownUntil.getTime() > snapshot.now.getTime();

  if (snapshot.status !== 'ACTIVE') {
    return {
      stateClass: 'NON_ACTIVE',
      eligible: false,
      reasonCode: 'ACCOUNT_STATE_NOT_ACTIVE',
      cooldownActive,
      withdrawalScopedChecksApplied: false,
    };
  }

  if (actionType !== 'WITHDRAWAL_REQUEST') {
    // Withdrawal-only columns are recorded for audit but do not refuse Earn/content.
    return {
      stateClass: 'ACTIVE_ALLOWED',
      eligible: true,
      reasonCode: 'ACCOUNT_STATE_OK',
      cooldownActive,
      withdrawalScopedChecksApplied: false,
    };
  }

  if (snapshot.withdrawalStatus === 'BLOCKED') {
    return {
      stateClass: 'BLOCKED',
      eligible: false,
      reasonCode: 'ACCOUNT_STATE_WITHDRAWAL_BLOCKED',
      cooldownActive,
      withdrawalScopedChecksApplied: true,
    };
  }

  if (cooldownActive) {
    return {
      stateClass: 'COOLDOWN',
      eligible: false,
      reasonCode: 'ACCOUNT_STATE_COOLDOWN_ACTIVE',
      cooldownActive: true,
      withdrawalScopedChecksApplied: true,
    };
  }

  if (snapshot.withdrawalStatus === 'RESTRICTED') {
    return {
      stateClass: 'RESTRICTED',
      eligible: true,
      reasonCode: 'ACCOUNT_STATE_RESTRICTED',
      cooldownActive: false,
      withdrawalScopedChecksApplied: true,
    };
  }

  return {
    stateClass: 'ACTIVE_ALLOWED',
    eligible: true,
    reasonCode: 'ACCOUNT_STATE_OK',
    cooldownActive: false,
    withdrawalScopedChecksApplied: true,
  };
}

/**
 * Resolve which feature-flag collector (if any) applies to an eligibility action.
 * Never silently maps unrelated actions to WITHDRAWAL_REQUESTS_PAUSE.
 */
export function resolveEligibilityFeatureFlagBinding(
  actionType: EligibilityActionType,
): EligibilityFeatureFlagBinding {
  switch (actionType) {
    case 'WITHDRAWAL_REQUEST':
      return { kind: 'pause_flag', flagKey: 'WITHDRAWAL_REQUESTS_PAUSE' };
    case 'MISSION_CLAIM':
      return { kind: 'mission_reward_pause' };
    case 'REFERRAL_ACTIVATION':
      return { kind: 'pause_flag', flagKey: 'REFERRAL_REWARD_PAUSE' };
    case 'AD_SESSION_START':
    case 'TASK_CLAIM':
    case 'MEMBERSHIP_CLAIM':
      return { kind: 'unsupported' };
    default: {
      const _exhaustive: never = actionType;
      return _exhaustive;
    }
  }
}
