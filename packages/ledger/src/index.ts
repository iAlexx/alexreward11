export { LedgerDomainError } from './errors.js';
export type { LedgerErrorCode } from './errors.js';

export {
  amountAtomicToString,
  parsePositiveAtomicAmount,
  parseSignedAtomicBalance,
  PG_BIGINT_MAX,
  PG_BIGINT_MIN,
} from './amounts.js';

export {
  isProtectedUserBucket,
  listCatalogueAccountTypes,
  normalSideDelta,
  resolveAccountSemantics,
  resolveProvisionableSemantics,
} from './catalogue.js';
export type { ResolvedAccountSemantics } from './catalogue.js';

export { getLedgerAccountById, getOrCreateLedgerAccount } from './accounts.js';

export { readUserLedgerBalances, USER_BALANCE_BUCKET_TYPES } from './user-balances.js';
export type {
  ReadUserLedgerBalancesInput,
  UserBalanceBucketType,
  UserLedgerBalanceBucket,
  UserLedgerBalances,
} from './user-balances.js';

export {
  assertAccountTypeAssetCompatibility,
  assertAssetActive,
  loadAsset,
  resolveHotWalletAssetAccountType,
} from './assets.js';
export type { AssetRecord } from './assets.js';

export { isPool, withLedgerTransaction } from './db.js';
export type { LedgerDb } from './db.js';

export { ledgerIntentFingerprint, intentsMatch } from './intent.js';

export { postLedgerTransaction, postLedgerTransactionWithReversalLink } from './posting.js';
export { reverseLedgerTransaction } from './reverse.js';
export {
  postOwnerAcknowledgedHotWalletUsdtFunding,
  newHotWalletFundingBusinessReferenceId,
} from './hot-wallet-funding.js';
export type {
  PostOwnerAcknowledgedHotWalletUsdtFundingInput,
  PostOwnerAcknowledgedHotWalletUsdtFundingResult,
} from './hot-wallet-funding.js';

export {
  PHASE10_PROVISION_AUDIT_ACTION,
  PHASE10_PROVISION_BUSINESS_REF_TYPE,
  PHASE10_PROVISION_IDEMPOTENCY_SCOPE,
  PHASE10_PROVISION_TOOL_VERSION,
  PHASE10_REVERSE_AUDIT_ACTION,
  PHASE10_REVERSE_BUSINESS_REF_TYPE,
  PHASE10_REVERSE_IDEMPOTENCY_SCOPE,
  provisionPhase10TestnetAvailable,
  reversePhase10TestnetAvailableProvision,
} from './phase10-testnet-provision.js';
export type {
  Phase10ProvisionIntent,
  Phase10ProvisionResult,
  Phase10ProvisionReverseResult,
  Phase10TestnetProvisionRuntimeConfig,
} from './phase10-testnet-provision.js';
export {
  PHASE10_OPERATIONAL_DATABASE_NAME,
  PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY,
  PHASE10_TESTNET_AALEX_DECIMALS,
  PHASE10_TESTNET_AALEX_PROVISION_ABSOLUTE_CEILING_ATOMIC,
  PHASE10_TESTNET_PROVISION_AALEX_SYMBOL,
  PHASE10_TESTNET_PROVISION_USDT_SYMBOL,
  isPhase10TestnetProvisionAssetSymbol,
} from './phase10-testnet-provision-assets.js';
export type { Phase10TestnetProvisionAssetSymbol } from './phase10-testnet-provision-assets.js';

export {
  rebuildAccountProjections,
  loadStoredProjections,
  compareProjectionsToStored,
} from './projection.js';
export type {
  RebuiltAccountProjection,
  StoredAccountProjection,
  ProjectionMismatch,
} from './projection.js';

export { checkLedgerInvariants } from './invariants.js';
export type { InvariantCheckResult, InvariantFinding, InvariantSeverity } from './invariants.js';

export type {
  ActorType,
  CanonicalLedgerEntry,
  LedgerAccountClass,
  LedgerAccountRecord,
  LedgerAccountType,
  LedgerEntryInput,
  LedgerOwnerType,
  LedgerSide,
  LedgerTransactionType,
  PostLedgerCommand,
  PostLedgerCommandWithReversalLink,
  PostedLedgerEntry,
  PostedLedgerTransaction,
  ReverseLedgerCommand,
} from './types.js';
