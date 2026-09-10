export { WithdrawalDomainError } from './errors.js';
export type { WithdrawalErrorCode } from './errors.js';

export {
  LOCKED_INITIAL_WITHDRAWAL,
  assertWithdrawalEngineConfig,
  localWithdrawalEngineFixtureConfig,
  withdrawalEngineConfigFromValidatedApi,
} from './config.js';
export type {
  DeploymentEnvironment,
  ValidatedWithdrawalApiConfig,
  WithdrawalEngineConfig,
} from './config.js';

export {
  applyPlatformFeeDiscount,
  atomicToString,
  computeNetAmount,
  parseNonNegativeAtomic,
  parsePositiveAtomic,
} from './arithmetic.js';

export { withWithdrawalTransaction, isPool } from './db.js';
export type { WithdrawalDb } from './db.js';

export { insertWithdrawalAuditLog, insertWithdrawalOutboxEvent } from './audit.js';

export {
  WITHDRAWAL_APPROVED_OUTBOX_EVENT,
  withdrawalApprovedDedupeKey,
  withdrawalWorkflowId,
} from './outbox.js';

export {
  WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
  claimPendingWithdrawalApprovedEvents,
  markOutboxDispatched,
  markOutboxRetry,
  startWithdrawalWorkflowFromOutbox,
  processWithdrawalApprovedOutboxBatch,
  redactOutboxError,
  outboxRetryBackoffSeconds,
} from './outbox-relay.js';
export type {
  WithdrawalApprovedOutboxEvent,
  StartWithdrawalWorkflowResult,
  ProcessWithdrawalApprovedOutboxBatchOptions,
  ProcessWithdrawalApprovedOutboxBatchResult,
  TemporalWorkflowStarter,
} from './outbox-relay.js';

export {
  registerFakePayoutScenario,
  takeFakePayoutScenario,
  clearFakePayoutScenarios,
} from './scenario-registry.js';

export {
  resolveActiveFeeRule,
  resolveActiveLimitRule,
  seedLockedInitialWithdrawalRules,
} from './rules.js';
export type { FeeRuleRow, LimitRuleRow } from './rules.js';

export { resolvePlatformFeeDiscount, resolvePriorityReview } from './entitlements.js';
export type { FeeDiscountEntitlement, PriorityEntitlement } from './entitlements.js';

export { assertWithdrawalRequestsAllowed, isPayoutDispatchPaused } from './flags.js';

export { requireEligiblePrimaryWallet } from './wallet-gate.js';
export type { EligiblePrimaryWallet } from './wallet-gate.js';

export {
  assertWithdrawalVolumeHeadroom,
  reserveWithdrawalVolume,
  resolveSingleTestHotWallet,
} from './volume.js';
export type { VolumeScope } from './volume.js';

export {
  assertTransitionAllowed,
  isTerminalState,
  workflowIdForWithdrawal,
} from './state-machine.js';
export type { WithdrawalState } from './state-machine.js';

export { FakePayoutChain, isAuthoritativePayoutObservation } from './fake-chain.js';
export type {
  AuthoritativePayoutObservation,
  FakeBroadcastPhase,
  FakePayoutIntent,
  FakePayoutObservation,
  FakePayoutScenario,
  PayoutChainAdapter,
} from './fake-chain.js';

export { createWithdrawalQuote, cancelWithdrawalQuote, expireWithdrawalQuote } from './quotes.js';
export type { WithdrawalQuoteView } from './quotes.js';

export { createWithdrawalFromQuote } from './create.js';
export type { WithdrawalView } from './create.js';

export { applyV1RiskPolicy } from './risk.js';
export type { V1RiskDecision } from './risk.js';

export { decideWithdrawal } from './decide.js';
export type { DecideWithdrawalResult, WithdrawalDecision } from './decide.js';

export { transitionWithdrawal } from './transitions.js';
export type { TransitionWithdrawalInput } from './transitions.js';

export { releaseWithdrawalReservation } from './release.js';
export { settleWithdrawalReservation } from './settlement.js';

export {
  createWithdrawalAttempt,
  updateAttemptBroadcastState,
  acquireTestDispatchLease,
} from './attempts.js';
export type { WithdrawalAttemptView } from './attempts.js';

export { runFakePayoutPipeline, advanceFakeReconciliation } from './pipeline.js';
export type { FakePayoutPipelineResult } from './pipeline.js';

export {
  reconcileWithdrawalAttemptFromAdapter,
  reconcileWithdrawalAttemptFromAdapterInTxn,
  matchIntendedPayout,
  observationMatchesExpectedAttempt,
} from './reconcile.js';
export type {
  ReconcileResolution,
  ReconcileFromAdapterInput,
  ReconcileWithdrawalAttemptResult,
} from './reconcile.js';

export { getWithdrawal, listWithdrawalsForUser } from './read.js';

export {
  PHASE10_MAINNET_GLOBAL_ID,
  PHASE10_NETWORK_CODE,
  PHASE10_NETWORK_GLOBAL_ID,
  assertPhase10Ready,
  buildPhase10PayoutConfig,
  listPhase10MissingResources,
  phase10ReadyCheck,
} from './phase10-config.js';
export type {
  Phase10ConfigInput,
  Phase10PayoutConfig,
  Phase10ProviderEndpointConfig,
  Phase10ProviderKind,
  Phase10ReadyCheck,
} from './phase10-config.js';

export { SignerHttpClient } from './signer-client.js';
export type {
  SignerClientDeps,
  SignerClientSignResult,
  SignerSigningIdentity,
} from './signer-client.js';

export {
  assertBlindResendForbidden,
  broadcastGate,
  classifySubmitError,
  markBroadcastSubmitted,
  persistPreBroadcastEvidence,
} from './broadcast-gate.js';
export type {
  BroadcastAmbiguityClass,
  BroadcastSubmitClassification,
  PersistPreBroadcastEvidenceInput,
} from './broadcast-gate.js';

export {
  confirmation,
  matchIntendedJettonPayout,
  primarySecondaryEvidenceAgree,
} from './confirmation.js';
export type { ExpectedJettonPayout } from './confirmation.js';

export { runRealTestnetPayoutPipeline } from './real-payout-pipeline.js';
export type {
  BuildCanonicalMessageHash,
  RealPayoutCanonicalIntent,
  RealPayoutSignerPort,
  RealTestnetPayoutPipelineResult,
  RealTestnetPayoutPipelineState,
  RunRealTestnetPayoutPipelineInput,
} from './real-payout-pipeline.js';
