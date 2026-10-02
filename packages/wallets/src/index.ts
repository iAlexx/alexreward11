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

export {
  PRIMARY_CHANGE_REQUIRES_FRESH_PROOF,
  PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS,
  TON_MAINNET_CONNECT_NETWORK_ID,
  TON_TESTNET_CONNECT_NETWORK_ID,
  assertAcceptedMainnetNetworkMapping,
  assertTonPayoutAddressShape,
  assertWalletAppNameNotAuthority,
  primaryChangePolicyNotes,
} from './phase21-mainnet-wallet-guards.js';
export type { MainnetNetworkMappingInput } from './phase21-mainnet-wallet-guards.js';
