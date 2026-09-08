import { LedgerDomainError } from './errors.js';
import type {
  LedgerAccountClass,
  LedgerAccountType,
  LedgerOwnerType,
  LedgerSide,
} from './types.js';

export interface ResolvedAccountSemantics {
  readonly accountType: LedgerAccountType;
  readonly ownerType: LedgerOwnerType;
  readonly accountClass: LedgerAccountClass;
  readonly normalSide: LedgerSide;
  readonly requiresOwnerId: boolean;
  /**
   * When true, catalogue refuses silent provision — V1.2 leaves final production
   * accounting classification as an explicit Owner decision.
   */
  readonly requiresOwnerAccountingDecision: boolean;
}

const PROTECTED_USER_BUCKETS = new Set<LedgerAccountType>([
  'USER_PENDING_LIABILITY',
  'USER_AVAILABLE_LIABILITY',
  'USER_RESERVED_LIABILITY',
]);

const CATALOGUE: Record<LedgerAccountType, ResolvedAccountSemantics> = {
  USER_PENDING_LIABILITY: {
    accountType: 'USER_PENDING_LIABILITY',
    ownerType: 'USER',
    accountClass: 'LIABILITY',
    normalSide: 'CREDIT',
    requiresOwnerId: true,
    requiresOwnerAccountingDecision: false,
  },
  USER_AVAILABLE_LIABILITY: {
    accountType: 'USER_AVAILABLE_LIABILITY',
    ownerType: 'USER',
    accountClass: 'LIABILITY',
    normalSide: 'CREDIT',
    requiresOwnerId: true,
    requiresOwnerAccountingDecision: false,
  },
  USER_RESERVED_LIABILITY: {
    accountType: 'USER_RESERVED_LIABILITY',
    ownerType: 'USER',
    accountClass: 'LIABILITY',
    normalSide: 'CREDIT',
    requiresOwnerId: true,
    requiresOwnerAccountingDecision: false,
  },
  PLATFORM_REWARD_EXPENSE: {
    accountType: 'PLATFORM_REWARD_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  MEMBERSHIP_BONUS_EXPENSE: {
    accountType: 'MEMBERSHIP_BONUS_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  REFERRAL_REWARD_EXPENSE: {
    accountType: 'REFERRAL_REWARD_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  TASK_REWARD_EXPENSE: {
    accountType: 'TASK_REWARD_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  MISSION_REWARD_EXPENSE: {
    accountType: 'MISSION_REWARD_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  WITHDRAWAL_FEE_REVENUE: {
    accountType: 'WITHDRAWAL_FEE_REVENUE',
    ownerType: 'PLATFORM',
    accountClass: 'REVENUE',
    normalSide: 'CREDIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  AD_REVENUE: {
    accountType: 'AD_REVENUE',
    ownerType: 'PLATFORM',
    accountClass: 'REVENUE',
    normalSide: 'CREDIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  AD_NETWORK_RECEIVABLE: {
    accountType: 'AD_NETWORK_RECEIVABLE',
    ownerType: 'PLATFORM',
    accountClass: 'ASSET',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  HOT_WALLET_USDT_ASSET: {
    accountType: 'HOT_WALLET_USDT_ASSET',
    ownerType: 'WALLET',
    accountClass: 'ASSET',
    normalSide: 'DEBIT',
    requiresOwnerId: true,
    requiresOwnerAccountingDecision: false,
  },
  HOT_WALLET_TON_ASSET: {
    accountType: 'HOT_WALLET_TON_ASSET',
    ownerType: 'WALLET',
    accountClass: 'ASSET',
    normalSide: 'DEBIT',
    requiresOwnerId: true,
    requiresOwnerAccountingDecision: false,
  },
  TREASURY_FUNDING_CLEARING: {
    accountType: 'TREASURY_FUNDING_CLEARING',
    ownerType: 'PLATFORM',
    // Final production class/side is OWNER_DECISION_REQUIRED (V1.2 §24).
    accountClass: 'LIABILITY',
    normalSide: 'CREDIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: true,
  },
  TON_NETWORK_FEE_EXPENSE: {
    accountType: 'TON_NETWORK_FEE_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  SUPPORT_COMPENSATION_EXPENSE: {
    accountType: 'SUPPORT_COMPENSATION_EXPENSE',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
  INVALID_TRAFFIC_RECOVERY: {
    accountType: 'INVALID_TRAFFIC_RECOVERY',
    ownerType: 'PLATFORM',
    accountClass: 'REVENUE',
    normalSide: 'CREDIT',
    requiresOwnerId: false,
    // Spec lists the type; production recognition policy remains explicit.
    requiresOwnerAccountingDecision: true,
  },
  EXPLICIT_PLATFORM_LOSS: {
    accountType: 'EXPLICIT_PLATFORM_LOSS',
    ownerType: 'PLATFORM',
    accountClass: 'EXPENSE',
    normalSide: 'DEBIT',
    requiresOwnerId: false,
    requiresOwnerAccountingDecision: false,
  },
};

export function isProtectedUserBucket(accountType: LedgerAccountType): boolean {
  return PROTECTED_USER_BUCKETS.has(accountType);
}

export function listCatalogueAccountTypes(): ReadonlyArray<LedgerAccountType> {
  return Object.keys(CATALOGUE) as LedgerAccountType[];
}

export function resolveAccountSemantics(accountType: LedgerAccountType): ResolvedAccountSemantics {
  const semantics = CATALOGUE[accountType];
  if (semantics === undefined) {
    throw new LedgerDomainError('VALIDATION', 'Unknown ledger account type', {
      details: { accountType },
    });
  }
  return semantics;
}

/**
 * Resolve semantics for provisioning. Types marked OWNER_DECISION_REQUIRED refuse
 * silent provision unless explicitly acknowledged for non-production/test use.
 */
export function resolveProvisionableSemantics(
  accountType: LedgerAccountType,
  options?: { readonly acknowledgeUnresolvedAccounting?: boolean },
): ResolvedAccountSemantics {
  const semantics = resolveAccountSemantics(accountType);
  if (
    semantics.requiresOwnerAccountingDecision &&
    options?.acknowledgeUnresolvedAccounting !== true
  ) {
    throw new LedgerDomainError(
      'OWNER_DECISION_REQUIRED',
      'Account type requires an explicit Owner accounting decision before provision',
      { details: { accountType } },
    );
  }
  return semantics;
}

/** Normal-side projection delta for one entry. */
export function normalSideDelta(
  normalSide: LedgerSide,
  direction: LedgerSide,
  amountAtomic: bigint,
): bigint {
  return direction === normalSide ? amountAtomic : -amountAtomic;
}
