/**
 * Phase 21 — read-only Mainnet preflight aggregator.
 *
 * Step 1 must NEVER emit READY_FOR_LIVE_PAYOUT.
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
  | 'READY_FOR_OWNER_MAINNET_PROVISIONING'
  | 'READY_FOR_OWNER_PROVISIONING_CEREMONY';

/** Explicitly excluded from Step 1 / this aggregator. */
export type Phase21ForbiddenPreflightVerdict = 'READY_FOR_LIVE_PAYOUT';

export interface Phase21PreflightReport {
  readonly verdict: Phase21PreflightVerdict;
  readonly readiness: Phase21ReadinessReport;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly readyForLivePayout: false;
  readonly notes: readonly string[];
}

const EXTERNAL_CODES = new Set([
  'MAINNET_JETTON_MASTER',
  'MAINNET_JETTON_EXTERNAL_VERIFICATION',
  'PRIMARY_PROVIDER',
  'SECONDARY_PROVIDER',
  'SIGNER_SERVICE',
  'SIGNER_CONFIG',
  'SIGNER_IDENTITY',
  'HOT_WALLET_REGISTERED',
  'HOT_WALLET_BALANCE',
  'TON_GAS',
]);

const OWNER_DECISION_CODES = new Set([
  'MAINNET_EXPLICIT_GATE',
  'MAINNET_TRANSFER_GAS_POLICY',
  'REAL_CHAIN_GATE',
  'WITHDRAWABLE_BALANCE_SOURCE',
  'WITHDRAWAL_REQUEST_PAUSE',
  'PAYOUT_DISPATCH_PAUSE',
  'RISK_POLICY',
  'TRUST_POLICY',
  'ELIGIBILITY_POLICY',
  'PHASE20_ARCHIVED',
]);

const SOURCE_WIRING_CODES = new Set([
  'MAINNET_CODE_SUPPORT',
  'WORKER_MAINNET_WIRING',
  'SIGNER_HOSTING_DECISION',
]);

/**
 * Aggregate readiness into a Step 1 preflight verdict.
 * Never returns READY_FOR_LIVE_PAYOUT.
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

  const externalBlocked = readiness.items.some(
    (i) => i.status === 'BLOCKED' && EXTERNAL_CODES.has(i.code),
  );
  const ownerBlocked = readiness.items.some(
    (i) => i.status === 'BLOCKED' && OWNER_DECISION_CODES.has(i.code),
  );
  const sourceWiringBlocked = readiness.items.some(
    (i) => i.status === 'BLOCKED' && SOURCE_WIRING_CODES.has(i.code),
  );

  let verdict: Phase21PreflightVerdict;
  if (sourceWiringBlocked) {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  } else if (externalBlocked) {
    verdict = 'BLOCKED_FOR_EXTERNAL_RESOURCES';
  } else if (ownerBlocked) {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  } else if (readiness.overall === 'BLOCKED') {
    verdict = 'BLOCKED_FOR_OWNER_DECISION';
  } else {
    // Source wiring + hosting decision complete; remaining blockers are external Owner resources.
    verdict = 'READY_FOR_OWNER_PROVISIONING_CEREMONY';
  }

  return {
    verdict,
    readiness,
    blockers,
    warnings,
    readyForLivePayout: false,
    notes: [
      'Step 2 preflight never emits READY_FOR_LIVE_PAYOUT',
      'No operational mutation, deploy, funding, or real key generation is authorized by this report',
    ],
  };
}
