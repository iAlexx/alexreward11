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
  WITHDRAWAL_OWNER_REVIEW_REQUIRED_OUTBOX_EVENT,
  withdrawalApprovedDedupeKey,
  withdrawalOwnerReviewRequiredDedupeKey,
  withdrawalWorkflowId,
} from './outbox.js';

export {
  WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
  claimPendingWithdrawalApprovedEvents,
  claimPendingOwnerReviewRequiredEvents,
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
  resolveSinglePayoutHotWallet,
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
  acquireHotWalletDispatchLease,
  acquireTestDispatchLease,
  assertHotWalletDispatchFence,
  hotWalletDispatchOwnerForWithdrawal,
  hotWalletDispatchOwnerIdentity,
  releaseHotWalletDispatchLease,
} from './attempts.js';
export type {
  HotWalletDispatchLeaseAcquireResult,
  HotWalletDispatchReleaseReason,
  WithdrawalAttemptView,
} from './attempts.js';

export { runFakePayoutPipeline, advanceFakeReconciliation } from './pipeline.js';
export type { FakePayoutPipelineResult } from './pipeline.js';

export {
  compactTep74EvidenceSummary,
  reconcileWithdrawalAttemptFromAdapter,
  reconcileWithdrawalAttemptFromAdapterInTxn,
  matchIntendedPayout,
  observationMatchesExpectedAttempt,
  persistIntendedPayoutProvenEvidence,
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

export { PipelineCrashError, runRealTestnetPayoutPipeline } from './real-payout-pipeline.js';
export type {
  BuildCanonicalMessageHash,
  RealPipelineCrashPoint,
  RealPayoutCanonicalIntent,
  RealPayoutSignerPort,
  RealTestnetPayoutPipelineResult,
  RealTestnetPayoutPipelineState,
  RunRealTestnetPayoutPipelineInput,
} from './real-payout-pipeline.js';

export { runPhase10Readiness } from './phase10-readiness.js';
export type {
  Phase10ReadinessClassification,
  Phase10ReadinessConfig,
  Phase10ReadinessItem,
  Phase10ReadinessReport,
  Phase10ReadinessStatus,
} from './phase10-readiness.js';

export { runPhase10RestoreReconcileScan } from './phase10-restore-reconcile.js';
export type {
  Phase10RestoreFinding,
  Phase10RestoreFindingCategory,
  Phase10RestoreReconcileScanReport,
  Phase10HistoricalBaselineInput,
  Phase10HistoricalBaselineAttemptState,
  Phase10RestoreReconcileScanOptions,
} from './phase10-restore-reconcile.js';

export { buildPhase10HotWalletMonitorReport } from './phase10-hot-wallet-monitor.js';
export type {
  Phase10HotWalletBalanceBaseline,
  Phase10HotWalletBalanceObservations,
  Phase10HotWalletMonitorInput,
  Phase10HotWalletMonitorReport,
} from './phase10-hot-wallet-monitor.js';
export { PHASE10_HOT_WALLET_CHAIN_HISTORY_PROOF_REQUIRED } from './phase10-hot-wallet-monitor.js';

export {
  checkPhase10PayoutInvariants,
  isCompleteIntendedPayoutProof,
} from './phase10-payout-invariants.js';
export type {
  CheckPhase10PayoutInvariantsOptions,
  Phase10IntendedPayoutProofExpected,
  Phase10IntendedPayoutProofOptions,
  Phase10InvariantFinding,
  Phase10InvariantSeverity,
  Phase10PayoutInvariantReport,
} from './phase10-payout-invariants.js';

export {
  PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS,
  PHASE10_FAILURE_SCENARIO_CATALOGUE,
  PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE,
  allRealExecutionGatesTrue,
  attachWithdrawal,
  attachWithdrawalIds,
  generateFinalCampaignEvidence,
  initCampaignManifest,
  initializeCampaign,
  isPhase10CampaignCompletionSatisfied,
  planPhase10Campaign,
  refreshEvidence,
  rescanCampaignEvidence,
  rescanWithdrawalsFromDb,
  resumeCampaign,
  resumeCampaignById,
  writeEvidenceFile,
} from './phase10-campaign.js';
export type {
  AttachPhase10CampaignWithdrawalInput,
  InitPhase10CampaignManifestInput,
  Phase10CampaignEvidenceRecord,
  Phase10CampaignManifest,
  Phase10CampaignMode,
  Phase10CampaignPlan,
  Phase10CampaignPlanItem,
  Phase10CampaignRealExecutionGates,
  Phase10CampaignRealModeGates,
  Phase10CampaignSafeHashes,
  Phase10FailureScenario,
  Phase10ScenarioClassification,
  PlanPhase10CampaignInput,
} from './phase10-campaign.js';

export { runPhase10Preflight } from './phase10-preflight.js';
export type {
  Phase10PreflightInput,
  Phase10PreflightReport,
  Phase10PreflightVerdict,
} from './phase10-preflight.js';

export {
  PHASE10_PROVIDER_INDEPENDENCE_UNPROVEN,
  PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
  PHASE10_TON_MAINNET_NETWORK_GLOBAL_ID,
  PRIMARY_PROVIDER_WRONG_NETWORK,
  SECONDARY_PROVIDER_WRONG_NETWORK,
  evaluateProviderIndependence,
  fingerprintProviderEndpoint,
  runPhase10LiveExternalProbes,
  signerLockedFromProbe,
} from './phase10-live-probes.js';
export type {
  Phase10LiveExternalProbeEvidence,
  Phase10LiveExternalProbeInput,
  Phase10ProviderProbeObservation,
  Phase10SignerProbeObservation,
  Phase10WalletSeqnoAdmissionObservation,
} from './phase10-live-probes.js';

export {
  PHASE10_LIVE_PREFLIGHT_EVIDENCE_SCHEMA_VERSION,
  buildPhase10LivePreflightEvidence,
  writePhase10LivePreflightEvidence,
} from './phase10-live-readiness-evidence.js';
export type {
  BuildPhase10LivePreflightEvidenceInput,
  Phase10LivePreflightEvidenceArtifact,
} from './phase10-live-readiness-evidence.js';

export {
  PHASE10_CHAIN_HISTORY_EVIDENCE_SCHEMA_VERSION,
  PHASE10_CHAIN_HISTORY_PROOF_REQUIRED,
  PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE,
  buildPhase10ChainHistoryEvidence,
  digestChainHistoryTransfers,
  evaluateChainHistoryForAcceptance,
  parsePhase10ChainHistoryEvidence,
  readPhase10ChainHistoryEvidence,
  writePhase10ChainHistoryEvidence,
} from './phase10-chain-history-evidence.js';
export type {
  BuildPhase10ChainHistoryEvidenceInput,
  Phase10ChainHistoryAcceptanceBinding,
  Phase10ChainHistoryEvidenceArtifact,
  Phase10ChainHistoryOutgoingTransfer,
  Phase10ChainHistoryReconciliationResult,
} from './phase10-chain-history-evidence.js';

export {
  PHASE10_CHAIN_HISTORY_COLLECTOR_VERSION,
  PHASE10_PROVIDER_HISTORY_DISAGREEMENT,
  PHASE10_CHAIN_HISTORY_INCOMPLETE,
  PHASE10_EXPECTED_CONFIRMED_OUTGOING,
  PHASE10_UNEXPECTED_OUTGOING,
  PHASE10_EXPECTED_PAYOUT_MISSING_FROM_HISTORY,
  PHASE10_DUPLICATE_ECONOMIC_PAYOUT,
  PHASE10_ZERO_UNEXPECTED,
  assertPhase10CollectorEvidenceIntegrity,
  buildPhase10EconomicKey,
  collectPhase10LiveProviderBackedChainHistory,
  digestPhase10CollectorEvidence,
  loadPhase10ExpectedCampaignPayouts,
  toPhase10ChainHistoryEvidenceArtifact,
} from './phase10-chain-history-collector.js';
export type {
  CollectPhase10LiveProviderBackedChainHistoryInput,
  LoadPhase10ExpectedCampaignPayoutsInput,
  Phase10ChainHistoryAgreementVerdict,
  Phase10ChainHistoryCollectorArtifact,
  Phase10ChainHistoryCollectorReconciliationResult,
  Phase10ChainHistoryProviderCoverage,
  Phase10ExpectedCampaignPayout,
  Phase10LiveProviderEndpointConfig,
} from './phase10-chain-history-collector.js';

export {
  PHASE10_READONLY_VALIDATION_SCHEMA_VERSION,
  assertPhase10ReadonlyValidationReportIntegrity,
  digestPhase10ReadonlyValidationReport,
  parsePhase10ReadonlyValidationReport,
  runPhase10ChainHistoryReadonlyValidate,
  writePhase10ReadonlyValidationReport,
} from './phase10-chain-history-readonly-validate.js';
export type {
  Phase10ReadonlyValidationAgreedTransfer,
  Phase10ReadonlyValidationCoverage,
  Phase10ReadonlyValidationHealth,
  Phase10ReadonlyValidationReport,
  Phase10ReadonlyValidationVerdict,
  RunPhase10ChainHistoryReadonlyValidateInput,
} from './phase10-chain-history-readonly-validate.js';

export {
  PHASE10_HISTORICAL_BASELINE_SCHEMA_VERSION,
  capturePhase10HistoricalBaseline,
  historicalBaselineInputFromArtifact,
  parsePhase10HistoricalBaseline,
  readPhase10HistoricalBaseline,
  writePhase10HistoricalBaseline,
} from './phase10-historical-baseline.js';
export type {
  Phase10HistoricalBaselineArtifact,
  Phase10HistoricalBaselineAttemptSnapshot,
} from './phase10-historical-baseline.js';

export { loadPhase10AuthoritativeHotWalletIdentity } from './phase10-hot-wallet-identity.js';
export type { Phase10AuthoritativeHotWalletIdentity } from './phase10-hot-wallet-identity.js';

export {
  PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS,
  evaluatePhase10AcceptanceGate,
  evaluatePhase10AcceptanceFromEvidence,
  parseLiveReadinessEvidence,
  validateFailureInjectionEvidence,
  validateLiveReadinessEvidence,
} from './phase10-acceptance-gate.js';
export type {
  ParsedLiveReadinessEvidence,
  Phase10AcceptanceFromEvidenceInput,
  Phase10AcceptanceGateInput,
  Phase10AcceptanceGateResult,
  Phase10AcceptanceGateVerdict,
  Phase10LiveEvidencePresence,
} from './phase10-acceptance-gate.js';
