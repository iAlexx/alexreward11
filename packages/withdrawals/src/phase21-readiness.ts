/**
 * Phase 21 — pure/source Mainnet micro-launch readiness report.
 *
 * Observation-driven. Does NOT force PASS. Typical Step 1 inputs remain BLOCKED.
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
  | 'UNKNOWN';

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

/**
 * Build a deterministic Phase 21 readiness report from observations.
 * Defaults assume Step 1 safe-off posture (Mainnet disabled, signer absent).
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
    code: 'MAINNET_EXPLICIT_GATE',
    status: phase21MainnetEnabled ? 'WARN' : 'BLOCKED',
    message: phase21MainnetEnabled
      ? 'PHASE21_MAINNET_ENABLED=true (Owner gate open; other blockers may remain)'
      : 'PHASE21_MAINNET_ENABLED is false/unset (default safe-off)',
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
      message: 'Signer observed unlocked; Step 1 expects LOCKED until Owner ceremony',
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
      message: 'TON gas observed for Hot Wallet',
    });
  } else {
    items.push({
      code: 'TON_GAS',
      status: 'BLOCKED',
      message: 'TON gas funding not observed / not authorized in Step 1',
    });
  }

  items.push({
    code: 'REAL_CHAIN_GATE',
    status: realChainEnabled ? 'WARN' : 'BLOCKED',
    message: realChainEnabled
      ? 'Real chain enabled (still fail-closed on other gates)'
      : 'WITHDRAWAL_REAL_CHAIN_ENABLED is false (default)',
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
        message: `${label} policy state not observed in Step 1 source readiness`,
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
        : 'Phase20 real-money blocker mapping documented (gaps remain OPEN)',
  });

  items.push({
    code: 'WITHDRAWABLE_BALANCE_SOURCE',
    status: balanceSource === 'OWNER_APPROVED_SOURCE' ? 'PASS' : 'BLOCKED',
    message:
      balanceSource === 'OWNER_APPROVED_SOURCE'
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

/** Step 1 default observations: safe-off / not provisioned → overall BLOCKED. */
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
    balanceSource: 'BLOCKED_OWNER_DECISION',
    railwaySignerExists: false,
    realMoneyBlockerMappingPresent: true,
    requireUnlock: true,
  };
}
