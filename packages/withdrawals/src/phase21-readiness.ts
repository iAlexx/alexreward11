/**
 * Phase 21 — pure/source Mainnet micro-launch readiness report.
 *
 * Observation-driven. Does NOT force PASS. Step 3 defaults are source-ready
 * for foundations but still fail-closed for live payout.
 * No operational mutation, no Mainnet RPC, no secret disclosure.
 */
import {
  PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS,
  PHASE21_NETWORK_CODE,
  PHASE21_NETWORK_GLOBAL_ID,
  PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
  assessPhase21InitialFundingExposure,
} from './phase21-config.js';

export type Phase21ReadinessStatus = 'PASS' | 'WARN' | 'BLOCKED';

export interface Phase21ReadinessItem {
  readonly code: string;
  readonly status: Phase21ReadinessStatus;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Phase21WithdrawableBalanceSourceStatus =
  | 'BLOCKED_OWNER_DECISION'
  | 'OWNER_APPROVED_SOURCE'
  | 'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED'
  | 'UNKNOWN';

export type Phase21AttachedGramLifecycleObservation =
  | 'UNVERIFIED'
  | 'ESTIMATED'
  | 'OWNER_APPROVED';

export interface Phase21ReadinessObservations {
  readonly phase21MainnetEnabled?: boolean;
  readonly realChainEnabled?: boolean;
  readonly fakeChainEnabled?: boolean;
  readonly networkCode?: string | null;
  readonly networkGlobalId?: number | null;
  readonly jettonMaster?: string | null;
  readonly primaryProviderKind?: string | null;
  readonly primaryProviderUrl?: string | null;
  readonly secondaryProviderKind?: string | null;
  readonly secondaryProviderUrl?: string | null;
  readonly signerBaseUrl?: string | null;
  readonly signerServiceTokenConfigured?: boolean;
  readonly signerProvisioned?: boolean;
  readonly signerLocked?: boolean | null;
  readonly signerIdentityMatches?: boolean | null;
  readonly signerKeyMode?: string | null;
  readonly hotWalletRegistered?: boolean;
  readonly hotWalletUsdtAtomicObserved?: bigint | null;
  readonly tonGasObserved?: boolean | null;
  readonly withdrawalRequestsPaused?: boolean | null;
  readonly payoutDispatchPaused?: boolean | null;
  readonly autoPayoutAllowed?: boolean;
  readonly autoUnpauseAllowed?: boolean;
  readonly autoResendAllowed?: boolean;
  readonly manualApprovalOnly?: boolean;
  readonly phase20Archived?: boolean;
  readonly riskPolicyActive?: boolean | null;
  readonly trustPolicyActive?: boolean | null;
  readonly eligibilityPolicyActive?: boolean | null;
  readonly reconciliationHealthy?: boolean | null;
  readonly ledgerInvariantsHealthy?: boolean | null;
  readonly confirmedWithdrawalCount?: number;
  readonly balanceSource?: Phase21WithdrawableBalanceSourceStatus;
  readonly railwaySignerExists?: boolean;
  readonly realMoneyBlockerMappingPresent?: boolean;
  readonly requireUnlock?: boolean;
  readonly workerMainnetWiringComplete?: boolean;
  /** @deprecated Prefer mainnetForwardGramPolicyApproved (forward=1 nanogram). */
  readonly mainnetTransferGasPolicyApproved?: boolean;
  /** Owner-approved forwardTonAtomic=1 nanogram (Phase21). */
  readonly mainnetForwardGramPolicyApproved?: boolean;
  readonly mainnetAttachedGramLifecycle?: Phase21AttachedGramLifecycleObservation;
  readonly mainnetJettonExternalVerified?: boolean | null;
  readonly signerHostingDecisionDocumented?: boolean;
  readonly signerHostingDecision?: string | null;
  readonly gramNamingCompatibilityDocumented?: boolean;
  readonly multichainWalletHardeningReady?: boolean;
  readonly controlledProvisionToolingReady?: boolean;
  readonly offlineMainnetCeremonyToolingReady?: boolean;
  /** Step 3A source correction observations (must PASS for ceremony readiness). */
  readonly controlledProvisionOperationalModeReady?: boolean;
  readonly liveFeeEstimatorHonest?: boolean;
  readonly productionEnvCutoverPlanReady?: boolean;
  readonly externalVerifierHardened?: boolean;
  readonly withdrawalRequestPauseFailClosed?: boolean;
  readonly productionFlagBaselineToolReady?: boolean;
  readonly mainnetRegistryBootstrapReady?: boolean;
  /** Step 3B ceremony tooling hardening observations. */
  readonly forceApplyRemoved?: boolean;
  readonly productionFlagBaselineAtomic?: boolean;
  readonly mainnetRegistryOnePassAtomic?: boolean;
  readonly concreteExternalAdaptersReady?: boolean;
  readonly concreteFeeAdapterReady?: boolean;
  readonly hotWalletRegistrationToolReady?: boolean;
}

export interface Phase21ReadinessReport {
  readonly overall: Phase21ReadinessStatus;
  readonly items: readonly Phase21ReadinessItem[];
  readonly summary: {
    readonly phase21MainnetEnabled: boolean;
    readonly realChainEnabled: boolean;
    readonly fakeChainEnabled: boolean;
    readonly networkCode: string | null;
    readonly networkGlobalId: number | null;
    readonly confirmedWithdrawalCount: number;
    readonly requiredConfirmed: number;
    readonly balanceSource: Phase21WithdrawableBalanceSourceStatus;
    readonly railwaySignerExists: boolean;
    readonly productionSignerService: 'NOT_PROVISIONED' | 'OBSERVED';
    readonly passCount: number;
    readonly warnCount: number;
    readonly blockedCount: number;
  };
}

function rollup(items: readonly Phase21ReadinessItem[]): Phase21ReadinessStatus {
  if (items.some((i) => i.status === 'BLOCKED')) return 'BLOCKED';
  if (items.some((i) => i.status === 'WARN')) return 'WARN';
  return 'PASS';
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isForbiddenJetton(identity: string): boolean {
  const upper = identity.trim().toUpperCase();
  return PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS.some(
    (p) => p.toUpperCase() === upper || upper.includes('TESTNET'),
  );
}

function balanceSourcePasses(balanceSource: Phase21WithdrawableBalanceSourceStatus): boolean {
  return (
    balanceSource === 'OWNER_APPROVED_SOURCE' ||
    balanceSource === 'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED'
  );
}

/**
 * Build a deterministic Phase 21 readiness report from observations.
 * Defaults assume Step 3 source-ready posture (Mainnet still disabled operationally).
 */
export function buildPhase21ReadinessReport(
  observations: Phase21ReadinessObservations = {},
): Phase21ReadinessReport {
  const phase21MainnetEnabled = observations.phase21MainnetEnabled === true;
  const realChainEnabled = observations.realChainEnabled === true;
  const fakeChainEnabled = observations.fakeChainEnabled === true;
  const networkCode = observations.networkCode?.trim() || null;
  const networkGlobalId =
    typeof observations.networkGlobalId === 'number' ? observations.networkGlobalId : null;
  const jettonMaster = observations.jettonMaster?.trim() || null;
  const balanceSource: Phase21WithdrawableBalanceSourceStatus =
    observations.balanceSource ?? 'BLOCKED_OWNER_DECISION';
  const railwaySignerExists = observations.railwaySignerExists === true;
  const confirmedWithdrawalCount = Math.max(0, Math.trunc(observations.confirmedWithdrawalCount ?? 0));
  const forwardApproved =
    observations.mainnetForwardGramPolicyApproved === true ||
    observations.mainnetTransferGasPolicyApproved === true;
  const attachedLifecycle: Phase21AttachedGramLifecycleObservation =
    observations.mainnetAttachedGramLifecycle ?? 'ESTIMATED';
  const items: Phase21ReadinessItem[] = [];

  items.push({
    code: 'PHASE20_ARCHIVED',
    status: observations.phase20Archived === true ? 'PASS' : 'BLOCKED',
    message:
      observations.phase20Archived === true
        ? 'Phase 20 Closed Beta archived (context preserved)'
        : 'Phase 20 archive evidence not confirmed for Phase 21 foundation',
    details: { phase20Archived: observations.phase20Archived === true },
  });

  items.push({
    code: 'MAINNET_CODE_SUPPORT',
    status: 'PASS',
    message: `Phase21 source supports ${PHASE21_NETWORK_CODE}/${PHASE21_NETWORK_GLOBAL_ID}`,
    details: {
      supportedNetworkCode: PHASE21_NETWORK_CODE,
      supportedNetworkGlobalId: PHASE21_NETWORK_GLOBAL_ID,
    },
  });

  items.push({
    code: 'WORKER_MAINNET_WIRING',
    status: observations.workerMainnetWiringComplete === false ? 'BLOCKED' : 'PASS',
    message:
      observations.workerMainnetWiringComplete === false
        ? 'Worker Phase 21 Mainnet wiring incomplete in source'
        : 'Worker source supports explicit Phase 21 Mainnet selection (default OFF)',
    details: { workerMainnetWiringComplete: observations.workerMainnetWiringComplete !== false },
  });

  items.push({
    code: 'MAINNET_TRANSFER_GAS_POLICY',
    status: forwardApproved ? 'PASS' : 'BLOCKED',
    message: forwardApproved
      ? 'Owner-approved Mainnet forward GRAM policy (1 nanogram); attached remains ESTIMATED'
      : 'BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY',
    details: {
      mainnetForwardGramPolicyApproved: forwardApproved,
      mainnetTransferGasPolicyApproved: observations.mainnetTransferGasPolicyApproved === true,
      attachedGramLifecycle: attachedLifecycle,
      note: 'attachedTonAtomic NOT Owner-approved; SPIKE policy must not be used by Phase21',
    },
  });

  items.push({
    code: 'MAINNET_ATTACHED_GRAM_POLICY',
    status: attachedLifecycle === 'OWNER_APPROVED' ? 'PASS' : 'BLOCKED',
    message:
      attachedLifecycle === 'OWNER_APPROVED'
        ? 'Mainnet attached GRAM Owner-approved'
        : 'OWNER_DECISION_REQUIRED: Mainnet attached GRAM lifecycle is ESTIMATED (not activated)',
    details: {
      mainnetAttachedGramLifecycle: attachedLifecycle,
      livePayoutOnly: true,
    },
  });

  items.push({
    code: 'GRAM_NAMING_COMPATIBILITY',
    status: observations.gramNamingCompatibilityDocumented === false ? 'BLOCKED' : 'PASS',
    message:
      observations.gramNamingCompatibilityDocumented === false
        ? 'GRAM naming compatibility not documented'
        : 'GRAM native display/canonical documented; chain remains TON_MAINNET (not renamed)',
    details: {
      gramNamingCompatibilityDocumented: observations.gramNamingCompatibilityDocumented !== false,
    },
  });

  items.push({
    code: 'MULTICHAIN_WALLET_HARDENING',
    status: observations.multichainWalletHardeningReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.multichainWalletHardeningReady === false
        ? 'Multichain wallet hardening incomplete (TON Connect Mainnet-only expected)'
        : 'TON Connect Mainnet-only payout wallet hardening documented/source-ready',
    details: {
      multichainWalletHardeningReady: observations.multichainWalletHardeningReady !== false,
    },
  });

  items.push({
    code: 'CONTROLLED_PROVISION_TOOLING',
    status: observations.controlledProvisionToolingReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.controlledProvisionToolingReady === false
        ? 'Controlled Mainnet Available provision tooling not ready'
        : 'Controlled Mainnet Available provision tooling present (disabled by default; not executed)',
    details: {
      controlledProvisionToolingReady: observations.controlledProvisionToolingReady !== false,
    },
  });

  items.push({
    code: 'OFFLINE_MAINNET_CEREMONY_TOOLING',
    status: observations.offlineMainnetCeremonyToolingReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.offlineMainnetCeremonyToolingReady === false
        ? 'Offline Mainnet signer/Hot Wallet ceremony tooling incomplete'
        : 'Offline Mainnet ceremony CLI/reference present (not executed in Step 3)',
    details: {
      offlineMainnetCeremonyToolingReady:
        observations.offlineMainnetCeremonyToolingReady !== false,
    },
  });

  items.push({
    code: 'CONTROLLED_PROVISION_OPERATIONAL_MODE',
    status: observations.controlledProvisionOperationalModeReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.controlledProvisionOperationalModeReady === false
        ? 'Controlled provision operational ceremony env modes incomplete'
        : 'Controlled provision supports test mode and production operational ceremony gates',
    details: {
      controlledProvisionOperationalModeReady:
        observations.controlledProvisionOperationalModeReady !== false,
    },
  });

  items.push({
    code: 'LIVE_FEE_ESTIMATOR_HONEST',
    status: observations.liveFeeEstimatorHonest === false ? 'BLOCKED' : 'PASS',
    message:
      observations.liveFeeEstimatorHonest === false
        ? 'Live fee estimator honesty incomplete (must not relabel mock as LIVE_READ_ONLY)'
        : 'Live fee estimator honest (MOCK / LIVE_READ_ONLY / UNAVAILABLE)',
    details: { liveFeeEstimatorHonest: observations.liveFeeEstimatorHonest !== false },
  });

  items.push({
    code: 'PRODUCTION_ENV_CUTOVER_PLAN',
    status: observations.productionEnvCutoverPlanReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.productionEnvCutoverPlanReady === false
        ? 'Production environment cutover plan documentation incomplete'
        : 'Production DEPLOYMENT_ENV cutover plan documented (not executed)',
    details: {
      productionEnvCutoverPlanReady: observations.productionEnvCutoverPlanReady !== false,
    },
  });

  items.push({
    code: 'EXTERNAL_VERIFIER_HARDENED',
    status: observations.externalVerifierHardened === false ? 'BLOCKED' : 'PASS',
    message:
      observations.externalVerifierHardened === false
        ? 'External Mainnet verifier hardening incomplete'
        : 'External verifier independence + provenance hardening present',
    details: { externalVerifierHardened: observations.externalVerifierHardened !== false },
  });

  items.push({
    code: 'WITHDRAWAL_REQUEST_PAUSE_FAIL_CLOSED',
    status: observations.withdrawalRequestPauseFailClosed === false ? 'BLOCKED' : 'PASS',
    message:
      observations.withdrawalRequestPauseFailClosed === false
        ? 'WITHDRAWAL_REQUESTS_PAUSE missing-row fail-closed incomplete'
        : 'WITHDRAWAL_REQUESTS_PAUSE fails closed when missing in STAGING/PRODUCTION',
    details: {
      withdrawalRequestPauseFailClosed: observations.withdrawalRequestPauseFailClosed !== false,
    },
  });

  items.push({
    code: 'PRODUCTION_FLAG_BASELINE_TOOL',
    status: observations.productionFlagBaselineToolReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.productionFlagBaselineToolReady === false
        ? 'PRODUCTION safety flag baseline tooling incomplete'
        : 'PRODUCTION safety flag baseline tooling present (DRY_RUN default; not executed)',
    details: {
      productionFlagBaselineToolReady: observations.productionFlagBaselineToolReady !== false,
    },
  });

  items.push({
    code: 'MAINNET_REGISTRY_BOOTSTRAP',
    status: observations.mainnetRegistryBootstrapReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.mainnetRegistryBootstrapReady === false
        ? 'Mainnet registry bootstrap tooling incomplete'
        : 'Mainnet registry bootstrap tooling present (DRY_RUN default; not executed)',
    details: {
      mainnetRegistryBootstrapReady: observations.mainnetRegistryBootstrapReady !== false,
    },
  });

  items.push({
    code: 'FORCE_APPLY_REMOVED',
    status: observations.forceApplyRemoved === false ? 'BLOCKED' : 'PASS',
    message:
      observations.forceApplyRemoved === false
        ? 'forceApply bypass still present in ceremony tooling'
        : 'forceApply removed; APPLY only via production ceremony env gates',
    details: { forceApplyRemoved: observations.forceApplyRemoved !== false },
  });

  items.push({
    code: 'PRODUCTION_FLAG_BASELINE_ATOMIC',
    status: observations.productionFlagBaselineAtomic === false ? 'BLOCKED' : 'PASS',
    message:
      observations.productionFlagBaselineAtomic === false
        ? 'PRODUCTION flag baseline APPLY is not atomic'
        : 'PRODUCTION flag baseline APPLY is atomic (txn + advisory lock + versions)',
    details: {
      productionFlagBaselineAtomic: observations.productionFlagBaselineAtomic !== false,
    },
  });

  items.push({
    code: 'MAINNET_REGISTRY_ONE_PASS_ATOMIC',
    status: observations.mainnetRegistryOnePassAtomic === false ? 'BLOCKED' : 'PASS',
    message:
      observations.mainnetRegistryOnePassAtomic === false
        ? 'Mainnet registry one-pass atomic APPLY incomplete'
        : 'Mainnet registry zero-to-complete APPLY is one atomic transaction',
    details: {
      mainnetRegistryOnePassAtomic: observations.mainnetRegistryOnePassAtomic !== false,
    },
  });

  items.push({
    code: 'CONCRETE_EXTERNAL_ADAPTERS',
    status: observations.concreteExternalAdaptersReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.concreteExternalAdaptersReady === false
        ? 'Concrete Mainnet external adapters incomplete'
        : 'Concrete Mainnet Toncenter/TonAPI read-only adapters ready (no broadcast)',
    details: {
      concreteExternalAdaptersReady: observations.concreteExternalAdaptersReady !== false,
    },
  });

  items.push({
    code: 'CONCRETE_FEE_ADAPTER',
    status: observations.concreteFeeAdapterReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.concreteFeeAdapterReady === false
        ? 'Concrete Mainnet fee adapter incomplete'
        : 'Concrete Toncenter Mainnet fee adapter ready (UNAVAILABLE when untrustworthy)',
    details: { concreteFeeAdapterReady: observations.concreteFeeAdapterReady !== false },
  });

  items.push({
    code: 'HOT_WALLET_REGISTRATION_TOOL',
    status: observations.hotWalletRegistrationToolReady === false ? 'BLOCKED' : 'PASS',
    message:
      observations.hotWalletRegistrationToolReady === false
        ? 'Hot Wallet registration tooling incomplete'
        : 'Hot Wallet registration tooling ready (Owner inputs required; gated APPLY)',
    details: {
      hotWalletRegistrationToolReady: observations.hotWalletRegistrationToolReady !== false,
    },
  });

  if (observations.mainnetJettonExternalVerified === true) {
    items.push({
      code: 'MAINNET_JETTON_EXTERNAL_VERIFICATION',
      status: 'PASS',
      message: 'Mainnet Jetton master external verification observed',
    });
  } else if (observations.mainnetJettonExternalVerified === false) {
    items.push({
      code: 'MAINNET_JETTON_EXTERNAL_VERIFICATION',
      status: 'BLOCKED',
      message: 'Mainnet Jetton master failed external verification',
    });
  } else {
    items.push({
      code: 'MAINNET_JETTON_EXTERNAL_VERIFICATION',
      status: 'BLOCKED',
      message: 'Mainnet Jetton master not externally verified (optional live probe not run)',
    });
  }

  if (observations.signerHostingDecisionDocumented === true) {
    items.push({
      code: 'SIGNER_HOSTING_DECISION',
      status: 'PASS',
      message: `Signer hosting decision documented (${observations.signerHostingDecision ?? 'DEDICATED_CONTROLLED_HOST'})`,
      details: { signerHostingDecision: observations.signerHostingDecision ?? null },
    });
  } else {
    items.push({
      code: 'SIGNER_HOSTING_DECISION',
      status: 'BLOCKED',
      message: 'Signer hosting decision not documented',
    });
  }

  // Safe-off expected for Step 3: false → PASS; true → WARN (gate open, still not live-ready alone).
  items.push({
    code: 'MAINNET_EXPLICIT_GATE',
    status: phase21MainnetEnabled ? 'WARN' : 'PASS',
    message: phase21MainnetEnabled
      ? 'PHASE21_MAINNET_ENABLED=true (Owner gate open; other blockers may remain)'
      : 'PHASE21_MAINNET_ENABLED is false/unset (safe-off expected)',
    details: { phase21MainnetEnabled },
  });

  if (jettonMaster === null) {
    items.push({
      code: 'MAINNET_JETTON_MASTER',
      status: 'BLOCKED',
      message: 'TON_MAINNET_USDT_JETTON_MASTER absent (OWNER_EXTERNAL_RESOURCE_REQUIRED)',
    });
  } else if (isForbiddenJetton(jettonMaster)) {
    items.push({
      code: 'MAINNET_JETTON_MASTER',
      status: 'BLOCKED',
      message: 'Forbidden Testnet/local Jetton placeholder cannot be used as Mainnet master',
      details: { rejected: true },
    });
  } else {
    items.push({
      code: 'MAINNET_JETTON_MASTER',
      status: 'PASS',
      message: 'Mainnet USDT Jetton master configured (value redacted)',
      details: { configured: true },
    });
  }

  const primaryOk =
    nonEmpty(observations.primaryProviderKind) && nonEmpty(observations.primaryProviderUrl);
  items.push({
    code: 'PRIMARY_PROVIDER',
    status: primaryOk ? 'PASS' : 'BLOCKED',
    message: primaryOk
      ? 'Primary Mainnet TON provider configured'
      : 'Primary Mainnet TON provider missing',
    details: {
      kindConfigured: nonEmpty(observations.primaryProviderKind),
      urlConfigured: nonEmpty(observations.primaryProviderUrl),
    },
  });

  const secondaryOk =
    nonEmpty(observations.secondaryProviderKind) && nonEmpty(observations.secondaryProviderUrl);
  const independent =
    primaryOk &&
    secondaryOk &&
    (observations.primaryProviderKind?.trim().toLowerCase() !==
      observations.secondaryProviderKind?.trim().toLowerCase() ||
      observations.primaryProviderUrl?.trim() !== observations.secondaryProviderUrl?.trim());
  items.push({
    code: 'SECONDARY_PROVIDER',
    status: secondaryOk && independent ? 'PASS' : 'BLOCKED',
    message:
      !secondaryOk
        ? 'Secondary Mainnet TON provider missing'
        : independent
          ? 'Secondary provider configured and independent from primary'
          : 'Secondary provider must be operationally independent from primary',
    details: {
      kindConfigured: nonEmpty(observations.secondaryProviderKind),
      urlConfigured: nonEmpty(observations.secondaryProviderUrl),
      independent,
    },
  });

  const signerProvisioned = observations.signerProvisioned === true || railwaySignerExists;
  items.push({
    code: 'SIGNER_SERVICE',
    status: signerProvisioned ? 'WARN' : 'BLOCKED',
    message: signerProvisioned
      ? 'Signer service observed/provisioned flag set (still not live-payout ready by itself)'
      : 'PRODUCTION_SIGNER_SERVICE=NOT_PROVISIONED',
    details: { railwaySignerExists, signerProvisioned },
  });

  const signerConfigOk =
    nonEmpty(observations.signerBaseUrl) &&
    observations.signerServiceTokenConfigured === true &&
    observations.signerKeyMode === 'self_hosted_encrypted';
  items.push({
    code: 'SIGNER_CONFIG',
    status: signerConfigOk ? 'PASS' : 'BLOCKED',
    message: signerConfigOk
      ? 'Signer config shape ready (self_hosted_encrypted; token not disclosed)'
      : 'Signer config incomplete (base URL / token / self_hosted_encrypted required)',
    details: {
      baseUrlConfigured: nonEmpty(observations.signerBaseUrl),
      serviceTokenConfigured: observations.signerServiceTokenConfigured === true,
      signerKeyMode: observations.signerKeyMode ?? null,
    },
  });

  if (observations.signerLocked === true) {
    items.push({
      code: 'SIGNER_LOCKED',
      status: 'PASS',
      message: 'Signer observed LOCKED (required boot posture)',
    });
  } else if (observations.signerLocked === false) {
    items.push({
      code: 'SIGNER_LOCKED',
      status: 'WARN',
      message: 'Signer observed unlocked; Phase21 expects LOCKED until Owner ceremony',
    });
  } else {
    items.push({
      code: 'SIGNER_LOCKED',
      status: 'BLOCKED',
      message: 'Signer lock state unknown / not provisioned',
    });
  }

  if (observations.signerIdentityMatches === true) {
    items.push({
      code: 'SIGNER_IDENTITY',
      status: 'PASS',
      message: 'Signer identity matches expected Hot Wallet',
    });
  } else if (observations.signerIdentityMatches === false) {
    items.push({
      code: 'SIGNER_IDENTITY',
      status: 'BLOCKED',
      message: 'Signer identity does not match expected Hot Wallet',
    });
  } else {
    items.push({
      code: 'SIGNER_IDENTITY',
      status: 'BLOCKED',
      message: 'Signer identity not verified (Hot Wallet not provisioned)',
    });
  }

  items.push({
    code: 'HOT_WALLET_REGISTERED',
    status: observations.hotWalletRegistered === true ? 'PASS' : 'BLOCKED',
    message:
      observations.hotWalletRegistered === true
        ? 'Hot Wallet registered'
        : 'Production Hot Wallet not registered',
  });

  const funding = assessPhase21InitialFundingExposure(
    observations.hotWalletUsdtAtomicObserved ?? null,
  );
  items.push({
    code: 'HOT_WALLET_BALANCE',
    status:
      funding.status === 'WITHIN_BAND'
        ? 'PASS'
        : funding.status === 'NOT_OBSERVED'
          ? 'BLOCKED'
          : 'BLOCKED',
    message: funding.message,
    details: { fundingStatus: funding.status },
  });

  if (observations.tonGasObserved === true) {
    items.push({
      code: 'TON_GAS',
      status: 'PASS',
      message: 'GRAM gas observed for Hot Wallet (native display GRAM; chain remains TON)',
    });
  } else {
    items.push({
      code: 'TON_GAS',
      status: 'BLOCKED',
      message: 'GRAM gas funding not observed / not authorized in Step 3',
    });
  }

  // Safe-off expected: false → PASS; true → WARN.
  items.push({
    code: 'REAL_CHAIN_GATE',
    status: realChainEnabled ? 'WARN' : 'PASS',
    message: realChainEnabled
      ? 'Real chain enabled (still fail-closed on other gates)'
      : 'WITHDRAWAL_REAL_CHAIN_ENABLED is false (safe-off expected)',
    details: { realChainEnabled },
  });

  items.push({
    code: 'FAKE_CHAIN_DISABLED',
    status: fakeChainEnabled ? 'BLOCKED' : 'PASS',
    message: fakeChainEnabled
      ? 'Fake chain must be disabled for Mainnet'
      : 'Fake chain disabled',
    details: { fakeChainEnabled },
  });

  if (observations.withdrawalRequestsPaused === true) {
    items.push({
      code: 'WITHDRAWAL_REQUEST_PAUSE',
      status: 'PASS',
      message: 'Withdrawal requests paused (required until separate Owner ceremony)',
    });
  } else if (observations.withdrawalRequestsPaused === false) {
    items.push({
      code: 'WITHDRAWAL_REQUEST_PAUSE',
      status: 'BLOCKED',
      message: 'Withdrawal requests unpaused without Phase21 ceremony authorization',
    });
  } else {
    items.push({
      code: 'WITHDRAWAL_REQUEST_PAUSE',
      status: 'BLOCKED',
      message: 'Withdrawal request pause state unknown (treat as not ready)',
    });
  }

  if (observations.payoutDispatchPaused === true) {
    items.push({
      code: 'PAYOUT_DISPATCH_PAUSE',
      status: 'PASS',
      message: 'Payout dispatch paused (required until separate Owner ceremony)',
    });
  } else if (observations.payoutDispatchPaused === false) {
    items.push({
      code: 'PAYOUT_DISPATCH_PAUSE',
      status: 'BLOCKED',
      message: 'Payout dispatch unpaused without Phase21 ceremony authorization',
    });
  } else {
    items.push({
      code: 'PAYOUT_DISPATCH_PAUSE',
      status: 'BLOCKED',
      message: 'Payout dispatch pause state unknown (treat as not ready)',
    });
  }

  items.push({
    code: 'AUTO_PAYOUT_DISABLED',
    status: observations.autoPayoutAllowed === true ? 'BLOCKED' : 'PASS',
    message:
      observations.autoPayoutAllowed === true
        ? 'Auto payout must remain impossible for Phase21 micro-launch'
        : 'Auto payout disabled',
  });

  items.push({
    code: 'AUTO_UNPAUSE_DISABLED',
    status: observations.autoUnpauseAllowed === true ? 'BLOCKED' : 'PASS',
    message:
      observations.autoUnpauseAllowed === true
        ? 'Auto unpause must remain impossible'
        : 'Auto unpause disabled',
  });

  items.push({
    code: 'AUTO_RESEND_DISABLED',
    status: observations.autoResendAllowed === true ? 'BLOCKED' : 'PASS',
    message:
      observations.autoResendAllowed === true
        ? 'Auto/blind resend must remain impossible'
        : 'Auto/blind resend disabled',
  });

  for (const [code, value, label] of [
    ['RISK_POLICY', observations.riskPolicyActive, 'Risk'] as const,
    ['TRUST_POLICY', observations.trustPolicyActive, 'Trust'] as const,
    ['ELIGIBILITY_POLICY', observations.eligibilityPolicyActive, 'Eligibility'] as const,
  ]) {
    if (value === true) {
      items.push({ code, status: 'PASS', message: `${label} policy ACTIVE` });
    } else if (value === false) {
      items.push({
        code,
        status: 'BLOCKED',
        message: `${label} policy not ACTIVE for Mainnet micro-launch`,
      });
    } else {
      items.push({
        code,
        status: 'WARN',
        message: `${label} policy state not observed in Step 3 source readiness`,
      });
    }
  }

  if (observations.reconciliationHealthy === true) {
    items.push({
      code: 'RECONCILIATION',
      status: 'PASS',
      message: 'Reconciliation gate healthy',
    });
  } else if (observations.reconciliationHealthy === false) {
    items.push({
      code: 'RECONCILIATION',
      status: 'BLOCKED',
      message: 'Reconciliation gate unhealthy',
    });
  } else {
    items.push({
      code: 'RECONCILIATION',
      status: 'BLOCKED',
      message: 'Reconciliation health not observed (no live Mainnet campaign yet)',
    });
  }

  if (observations.ledgerInvariantsHealthy === true) {
    items.push({
      code: 'LEDGER_INVARIANTS',
      status: 'PASS',
      message: 'Ledger invariants healthy',
    });
  } else if (observations.ledgerInvariantsHealthy === false) {
    items.push({
      code: 'LEDGER_INVARIANTS',
      status: 'BLOCKED',
      message: 'Ledger invariant violations present',
    });
  } else {
    items.push({
      code: 'LEDGER_INVARIANTS',
      status: 'BLOCKED',
      message: 'Ledger invariant campaign evidence not observed yet',
    });
  }

  items.push({
    code: 'MANUAL_APPROVAL_ONLY',
    status: observations.manualApprovalOnly === false ? 'BLOCKED' : 'PASS',
    message:
      observations.manualApprovalOnly === false
        ? 'Manual approval only required for Phase21'
        : 'Manual approval only enforced by Phase21 config',
  });

  items.push({
    code: 'REAL_MONEY_BLOCKER_MAPPING',
    status: observations.realMoneyBlockerMappingPresent === false ? 'BLOCKED' : 'PASS',
    message:
      observations.realMoneyBlockerMappingPresent === false
        ? 'docs/PHASE_21_REAL_MONEY_BLOCKER_MAPPING.md missing'
        : 'Phase20 real-money blocker mapping documented (AdsGram gaps remain OPEN)',
  });

  items.push({
    code: 'WITHDRAWABLE_BALANCE_SOURCE',
    status: balanceSourcePasses(balanceSource) ? 'PASS' : 'BLOCKED',
    message:
      balanceSource === 'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED'
        ? 'CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE=SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED'
        : balanceSource === 'OWNER_APPROVED_SOURCE'
          ? 'Controlled Mainnet withdrawable balance source Owner-approved'
          : 'CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE=BLOCKED_OWNER_DECISION',
    details: { balanceSource },
  });

  if (networkCode !== null && networkCode !== PHASE21_NETWORK_CODE && phase21MainnetEnabled) {
    items.push({
      code: 'NETWORK_CODE_MATCH',
      status: 'BLOCKED',
      message: `Observed networkCode ${networkCode} is not ${PHASE21_NETWORK_CODE}`,
    });
  }
  if (
    networkGlobalId !== null &&
    networkGlobalId !== PHASE21_NETWORK_GLOBAL_ID &&
    phase21MainnetEnabled
  ) {
    items.push({
      code: 'NETWORK_GLOBAL_ID_MATCH',
      status: 'BLOCKED',
      message: `Observed networkGlobalId ${networkGlobalId} is not ${PHASE21_NETWORK_GLOBAL_ID}`,
    });
  }

  if (observations.requireUnlock === false) {
    items.push({
      code: 'EXPLICIT_UNLOCK_REQUIRED',
      status: 'BLOCKED',
      message: 'Signer unlock must remain explicitly required',
    });
  } else {
    items.push({
      code: 'EXPLICIT_UNLOCK_REQUIRED',
      status: 'PASS',
      message: 'Explicit controlled unlock required (default)',
    });
  }

  const overall = rollup(items);
  return {
    overall,
    items,
    summary: {
      phase21MainnetEnabled,
      realChainEnabled,
      fakeChainEnabled,
      networkCode,
      networkGlobalId,
      confirmedWithdrawalCount,
      requiredConfirmed: PHASE21_REQUIRED_CONFIRMED_WITHDRAWALS,
      balanceSource,
      railwaySignerExists,
      productionSignerService: railwaySignerExists || signerProvisioned ? 'OBSERVED' : 'NOT_PROVISIONED',
      passCount: items.filter((i) => i.status === 'PASS').length,
      warnCount: items.filter((i) => i.status === 'WARN').length,
      blockedCount: items.filter((i) => i.status === 'BLOCKED').length,
    },
  };
}

/** Step 3 default observations: source-ready foundations; external/ops still blocked; no live payout. */
export function defaultPhase21Step1Observations(): Phase21ReadinessObservations {
  return {
    phase21MainnetEnabled: false,
    realChainEnabled: false,
    fakeChainEnabled: false,
    jettonMaster: null,
    primaryProviderKind: null,
    primaryProviderUrl: null,
    secondaryProviderKind: null,
    secondaryProviderUrl: null,
    signerBaseUrl: null,
    signerServiceTokenConfigured: false,
    signerProvisioned: false,
    signerLocked: null,
    signerIdentityMatches: null,
    signerKeyMode: null,
    hotWalletRegistered: false,
    hotWalletUsdtAtomicObserved: null,
    tonGasObserved: null,
    withdrawalRequestsPaused: true,
    payoutDispatchPaused: true,
    autoPayoutAllowed: false,
    autoUnpauseAllowed: false,
    autoResendAllowed: false,
    manualApprovalOnly: true,
    phase20Archived: true,
    riskPolicyActive: null,
    trustPolicyActive: null,
    eligibilityPolicyActive: null,
    reconciliationHealthy: null,
    ledgerInvariantsHealthy: null,
    confirmedWithdrawalCount: 0,
    balanceSource: 'SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED',
    railwaySignerExists: false,
    realMoneyBlockerMappingPresent: true,
    requireUnlock: true,
    workerMainnetWiringComplete: true,
    mainnetTransferGasPolicyApproved: true,
    mainnetForwardGramPolicyApproved: true,
    mainnetAttachedGramLifecycle: 'ESTIMATED',
    mainnetJettonExternalVerified: null,
    signerHostingDecisionDocumented: true,
    signerHostingDecision: 'DEDICATED_CONTROLLED_HOST',
    gramNamingCompatibilityDocumented: true,
    multichainWalletHardeningReady: true,
    controlledProvisionToolingReady: true,
    offlineMainnetCeremonyToolingReady: true,
    controlledProvisionOperationalModeReady: true,
    liveFeeEstimatorHonest: true,
    productionEnvCutoverPlanReady: true,
    externalVerifierHardened: true,
    withdrawalRequestPauseFailClosed: true,
    productionFlagBaselineToolReady: true,
    mainnetRegistryBootstrapReady: true,
    forceApplyRemoved: true,
    productionFlagBaselineAtomic: true,
    mainnetRegistryOnePassAtomic: true,
    concreteExternalAdaptersReady: true,
    concreteFeeAdapterReady: true,
    hotWalletRegistrationToolReady: true,
  };
}
