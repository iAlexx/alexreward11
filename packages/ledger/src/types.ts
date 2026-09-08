export type LedgerOwnerType = 'USER' | 'PLATFORM' | 'WALLET' | 'PROVIDER';
export type LedgerAccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type LedgerSide = 'DEBIT' | 'CREDIT';

export type LedgerAccountType =
  | 'USER_PENDING_LIABILITY'
  | 'USER_AVAILABLE_LIABILITY'
  | 'USER_RESERVED_LIABILITY'
  | 'PLATFORM_REWARD_EXPENSE'
  | 'MEMBERSHIP_BONUS_EXPENSE'
  | 'REFERRAL_REWARD_EXPENSE'
  | 'TASK_REWARD_EXPENSE'
  | 'MISSION_REWARD_EXPENSE'
  | 'WITHDRAWAL_FEE_REVENUE'
  | 'AD_REVENUE'
  | 'AD_NETWORK_RECEIVABLE'
  | 'HOT_WALLET_USDT_ASSET'
  | 'HOT_WALLET_TON_ASSET'
  | 'TREASURY_FUNDING_CLEARING'
  | 'TON_NETWORK_FEE_EXPENSE'
  | 'SUPPORT_COMPENSATION_EXPENSE'
  | 'INVALID_TRAFFIC_RECOVERY'
  | 'EXPLICIT_PLATFORM_LOSS';

export type LedgerTransactionType =
  | 'REWARD_ISSUANCE'
  | 'REWARD_MATURITY'
  | 'REWARD_REVERSAL'
  | 'MEMBERSHIP_BONUS_ISSUANCE'
  | 'REFERRAL_REWARD_ISSUANCE'
  | 'TASK_REWARD_ISSUANCE'
  | 'MISSION_REWARD_ISSUANCE'
  | 'WITHDRAWAL_RESERVATION'
  | 'WITHDRAWAL_RELEASE'
  | 'WITHDRAWAL_SETTLEMENT'
  | 'TON_NETWORK_FEE'
  | 'HOT_WALLET_FUNDING'
  | 'PROVIDER_REVENUE_ACCRUAL'
  | 'PROVIDER_SETTLEMENT'
  | 'INVALID_TRAFFIC_ADJUSTMENT'
  | 'SUPPORT_ADJUSTMENT'
  | 'PLATFORM_LOSS'
  | 'MANUAL_CORRECTION';

export type ActorType = 'SYSTEM' | 'USER' | 'ADMIN' | 'WORKER' | 'PROVIDER';

export interface LedgerAccountRecord {
  readonly id: string;
  readonly ownerType: LedgerOwnerType;
  readonly ownerId: string | null;
  readonly accountType: LedgerAccountType;
  readonly accountClass: LedgerAccountClass;
  readonly normalSide: LedgerSide;
  readonly assetId: string;
  readonly status: string;
}

export interface LedgerEntryInput {
  /** Resolved ledger account id, or null when providing resolution hint instead. */
  readonly ledgerAccountId?: string;
  readonly accountType?: LedgerAccountType;
  readonly ownerType?: LedgerOwnerType;
  readonly ownerId?: string | null;
  readonly direction: LedgerSide;
  /** Positive atomic amount as bigint or digit string. */
  readonly amountAtomic: bigint | string;
}

export interface CanonicalLedgerEntry {
  readonly ledgerAccountId: string;
  readonly direction: LedgerSide;
  readonly amountAtomic: bigint;
  readonly entryIndex: number;
}

export interface PostLedgerCommand {
  readonly transactionType: LedgerTransactionType;
  readonly businessReferenceType: string;
  readonly businessReferenceId?: string | null;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly assetId: string;
  readonly entries: ReadonlyArray<LedgerEntryInput>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdByType?: ActorType;
  readonly createdById?: string | null;
}

/**
 * Restricted posting command that links a reversal.
 * Must only be used via reverseLedgerTransaction (or guarded tests).
 * Entries must be an exact economic reversal of the original.
 */
export interface PostLedgerCommandWithReversalLink extends PostLedgerCommand {
  readonly reversesTransactionId: string;
}

export interface PostedLedgerEntry {
  readonly id: string;
  readonly ledgerAccountId: string;
  readonly direction: LedgerSide;
  readonly amountAtomic: string;
  readonly entryIndex: number;
}

export interface PostedLedgerTransaction {
  readonly id: string;
  readonly transactionType: LedgerTransactionType;
  readonly businessReferenceType: string;
  readonly businessReferenceId: string | null;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly assetId: string;
  readonly reversesTransactionId: string | null;
  readonly postedAt: string;
  readonly created: boolean;
  readonly entries: ReadonlyArray<PostedLedgerEntry>;
}

export interface ReverseLedgerCommand {
  readonly originalTransactionId: string;
  readonly transactionType: LedgerTransactionType;
  readonly businessReferenceType: string;
  readonly businessReferenceId?: string | null;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdByType?: ActorType;
  readonly createdById?: string | null;
}
