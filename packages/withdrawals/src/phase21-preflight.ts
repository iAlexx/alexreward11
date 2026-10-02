/**
 * Phase 21 — read-only Mainnet preflight aggregator.
 *
 * Step 3 must NEVER emit READY_FOR_LIVE_PAYOUT.
 * Distinguishes MAINNET_SOURCE_READY vs READY_FOR_OWNER_PROVISIONING_CEREMONY.
 */
import {
  buildPhase21ReadinessReport,
  defaultPhase21Step1Observations,
  type Phase21ReadinessObservations,
  type Phase21ReadinessReport,
} from './phase21-readiness.js';

export type Phase21PreflightVerdict =
  | 'BLOCKED_FOR_EXTERNAL_RESOURCES'
  | 'BLOCKED_FOR_OWNER_DECISION'
  | 'MAINNET_SOURCE_READY'
  | 'READY_FOR_OWNER_PROVISIONING_CEREMONY';

/** Explicitly excluded from Step 3 / this aggregator. */
export type Phase21ForbiddenPreflightVerdict = 'READY_FOR_LIVE_PAYOUT';

export interface Phase21PreflightReport {
  readonly verdict: Phase21PreflightVerdict;
  readonly readiness: Phase21ReadinessReport;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly readyForLivePayout: false;
  readonly notes: readonly string[];
}

/** External / operational resources required before ceremony execution. */
const EXTERNAL_CODES = new Set([
  'MAINNET_JETTON_MASTER',
  'MAINNET_JETTON_EXTERNAL_VERIFICATION',
  'PRIMARY_PROVIDER',
  'SECONDARY_PROVIDER',
  'SIGNER_SERVICE',
  'SIGNER_CONFIG',
  'SIGNER_LOCKED',
  'SIGNER_IDENTITY',
  'HOT_WALLET_REGISTERED',
  'HOT_WALLET_BALANCE',
  'TON_GAS',
]);

/** Live-campaign / live-payout-only blockers — do not block Owner provisioning ceremony. */
const LIVE_ONLY_CODES = new Set([
  'MAINNET_ATTACHED_GRAM_POLICY',
  'RECONCILIATION',
  'LEDGER_INVARIANTS',
]);

/** Core source wiring that must exist before MAINNET_SOURCE_READY. */
const CORE_SOURCE_WIRING_CODES = new Set([
  'PHASE20_ARCHIVED',
  'MAINNET_CODE_SUPPORT',
  'WORKER_MAINNET_WIRING',
  'SIGNER_HOSTING_DECISION',
  'FAKE_CHAIN_DISABLED',
  'AUTO_PAYOUT_DISABLED',
  'AUTO_UNPAUSE_DISABLED',
  'AUTO_RESEND_DISABLED',
  'MANUAL_APPROVAL_ONLY',
  'REAL_MONEY_BLOCKER_MAPPING',
  'EXPLICIT_UNLOCK_REQUIRED',
  'MAINNET_EXPLICIT_GATE',
  'REAL_CHAIN_GATE',
]);

/** Full Step 3 source foundations required for READY_FOR_OWNER_PROVISIONING_CEREMONY. */
const FULL_SOURCE_FOUNDATION_CODES = new Set([
  ...CORE_SOURCE_WIRING_CODES,
  'WITHDRAWABLE_BALANCE_SOURCE',
  'MAINNET_TRANSFER_GAS_POLICY',
  'GRAM_NAMING_COMPATIBILITY',
  'MULTICHAIN_WALLET_HARDENING',
  'CONTROLLED_PROVISION_TOOLING',
  'OFFLINE_MAINNET_CEREMONY_TOOLING',
]);

/** Hard owner operational mistakes (e.g. unpaused without ceremony). */
const OWNER_HARD_BLOCK_CODES = new Set([
  'WITHDRAWAL_REQUEST_PAUSE',
  'PAYOUT_DISPATCH_PAUSE',
  'RISK_POLICY',
  'TRUST_POLICY',
  'ELIGIBILITY_POLICY',
]);

/**
 * Aggregate readiness into a Step 3 preflight verdict.
 * Never returns READY_FOR_LIVE_PAYOUT. readyForLivePayout is always false.
 */
export function runPhase21Preflight(
  observations: Phase21ReadinessObservations = defaultPhase21Step1Observations(),
): Phase21PreflightReport {
  const readiness = buildPhase21ReadinessReport(observations);
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const item of readiness.items) {
    if (item.status === 'BLOCKED') {
      blockers.push(`${item.code}: ${item.message}`);
    } else if (item.status === 'WARN') {
      warnings.push(`${item.code}: ${item.message}`);
    }
  }

  const blockedCodes = new Set(
    readiness.items.filter((i) => i.status === 'BLOCKED').map((i) => i.code),
  );

  const coreWiringBlocked = [...CORE_SOURCE_WIRING_CODES].some((c) => blockedCodes.has(c));
  const fullFoundationBlocked = [...FULL_SOURCE_FOUNDATION_CODES].some((c) =>
    blockedCodes.has(c),
  );
  const ownerHardBlocked = [...OWNER_HARD_BLOCK_CODES].some((c) => blockedCodes.has(c));
  const externalBlocked = [...EXTERNAL_CODES].some((c) => blockedCodes.has(c));

  const nonExemptBlocked = [...blockedCodes].filter(
    (c) => !EXTERNAL_CODES.has(c) && !LIVE_ONLY_CODES.has(c),
  );
  const ownerNonExternalBlocked = nonExemptBlocked.filter(
    (c) => !FULL_SOURCE_FOUNDATION_CODES.has(c) || OWNER_HARD_BLOCK_CODES.has(c),
  );

  let verdict: Phase21PreflightVerdict;
  if (ownerHardBlocked || coreWiringBlocked) {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  } else if (!fullFoundationBlocked) {
    // Source foundations complete; remaining blockers are external and/or live-only.
    verdict = 'READY_FOR_OWNER_PROVISIONING_CEREMONY';
  } else if (ownerNonExternalBlocked.length > 0 && !externalBlocked) {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  } else if (fullFoundationBlocked && !coreWiringBlocked) {
    // Core wiring OK; some non-external source/owner foundation items remain.
    verdict = 'MAINNET_SOURCE_READY';
  } else if (externalBlocked) {
    verdict = 'BLOCKED_FOR_EXTERNAL_RESOURCES';
  } else {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  }

  return {
    verdict,
    readiness,
    blockers,
    warnings,
    readyForLivePayout: false,
    notes: [
      'Step 3 preflight never emits READY_FOR_LIVE_PAYOUT',
      'readyForLivePayout is always false in Step 3',
      'MAINNET_SOURCE_READY means source foundations are progressing; not live payout',
      'READY_FOR_OWNER_PROVISIONING_CEREMONY means remaining blockers are external/operational (or live-only attached GRAM)',
      'AdsGram monetary gaps remain OPEN; balance source may be SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED',
      'No operational mutation, deploy, funding, or real key generation is authorized by this report',
      'Canonical runtime remains production-runtime @ b9dd700; Phase21 not deployed',
    ],
  };
}
