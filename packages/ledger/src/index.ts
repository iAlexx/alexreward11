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

export { isPool, withLedgerTransaction } from './db.js';
export type { LedgerDb } from './db.js';

export { ledgerIntentFingerprint, intentsMatch } from './intent.js';

export { postLedgerTransaction } from './posting.js';
export { reverseLedgerTransaction } from './reverse.js';

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
  PostedLedgerEntry,
  PostedLedgerTransaction,
  ReverseLedgerCommand,
} from './types.js';
