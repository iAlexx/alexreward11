export { WalletDomainError, publicWalletFailureMessage } from './errors.js';
export type { WalletErrorCode } from './errors.js';
export {
  assertWalletOwnershipConfig,
  localWalletOwnershipFixtureConfig,
  type DeploymentEnvironment,
  type WalletOwnershipConfig,
  type WalletThrottlePolicy,
} from './config.js';
export { isPool, withWalletTransaction, type WalletDb } from './db.js';
export { resolveAcceptedTonNetwork, type AcceptedNetwork } from './network.js';
export {
  createTonProofChallenge,
  generateRawChallenge,
  hashChallenge,
  invalidateOpenWalletChallenges,
  type CreateTonProofChallengeInput,
  type TonProofChallenge,
} from './challenge.js';
export {
  verifyTonProofAndBindWallet,
  lockOpenChallenge,
  consumeChallenge,
  mapTonError,
  type BoundWalletResult,
  type VerifyTonProofAndBindWalletInput,
} from './verify-bind.js';
export {
  changePrimaryWallet,
  type ChangePrimaryWalletInput,
  type PrimaryWalletChangeResult,
  type PrimaryWalletChangedResult,
  type PrimaryWalletUnchangedResult,
} from './primary-change.js';
export { requireAuthenticatedUserId } from './session.js';
export { insertSecurityAuditLog, insertWalletOutboxEvent } from './audit.js';
