import { SendMode } from '@ton/core';

import { PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC } from '@alex-rewards/ton';

import { SignerError } from './errors.js';
import { PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC } from './gram-native-currency.js';

export { PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC };

/**
 * TESTNET/SPIKE only: attached TON/GRAM for jetton-wallet gas.
 * Not a production funding / Mainnet default. Must NOT be used by Phase 21.
 */
export const SPIKE_JETTON_ATTACHED_TON = 50_000_000n; // 0.05 TON/GRAM (SPIKE only)

/** TESTNET/SPIKE only: forward amount inside jetton transfer body. */
export const SPIKE_JETTON_FORWARD_TON = 1n;

export const SPIKE_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

/**
 * Lifecycle for Mainnet attached GRAM (gas). Forward is Owner-approved at 1 nanogram.
 * Attached GRAM is Owner-approved at 50_000_000 nanogram (0.05 GRAM) for Phase 21
 * Mainnet micro-launch — prior fee-estimate decision, now source-wired.
 */
export type AttachedGramLifecycleStatus = 'UNVERIFIED' | 'ESTIMATED' | 'OWNER_APPROVED';

export const PHASE21_ATTACHED_GRAM_POLICY_STATUS: AttachedGramLifecycleStatus = 'OWNER_APPROVED';

export const PHASE21_OWNER_APPROVED_ATTACHED_GRAM_SOURCE_REFERENCE =
  'PHASE21_OWNER_APPROVED_ATTACHED_50000000_NANOGRAM' as const;

export interface JettonTransferExecutionPolicy {
  /** Legacy internal field name; atomic unit is nanogram on Mainnet native GRAM. */
  readonly attachedTonAtomic: bigint;
  /** Legacy internal field name; Phase21 Owner-approved forward = 1 nanogram. */
  readonly forwardTonAtomic: bigint;
  readonly sendMode: number;
  readonly networkScope: 'TESTNET_SPIKE' | 'MAINNET_OWNER_APPROVED';
  readonly sourceReference: string;
  /** Required for MAINNET_OWNER_APPROVED. Defaults treated as UNVERIFIED when absent. */
  readonly attachedGramLifecycle?: AttachedGramLifecycleStatus;
}

/** Phase 10 / Testnet SPIKE policy — historical attached/forward values. Never use for Phase21. */
export const PHASE10_TESTNET_SPIKE_TRANSFER_POLICY: JettonTransferExecutionPolicy = {
  attachedTonAtomic: SPIKE_JETTON_ATTACHED_TON,
  forwardTonAtomic: SPIKE_JETTON_FORWARD_TON,
  sendMode: SPIKE_SEND_MODE,
  networkScope: 'TESTNET_SPIKE',
  sourceReference: 'PHASE10_TESTNET_SPIKE_CONSTANTS',
};

/**
 * Phase 21 Owner-approved Mainnet transfer policy fragment.
 * forward = 1 nanogram; attached = 50_000_000 nanogram (0.05 GRAM).
 * Must not be confused with PHASE10_TESTNET_SPIKE_TRANSFER_POLICY even when
 * attached atomic amounts numerically match.
 */
export const PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE: JettonTransferExecutionPolicy & {
  readonly attachedTonAtomic: typeof PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC;
  readonly forwardTonAtomic: typeof PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC;
  readonly attachedGramLifecycle: typeof PHASE21_ATTACHED_GRAM_POLICY_STATUS;
} = {
  attachedTonAtomic: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
  forwardTonAtomic: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
  sendMode: SPIKE_SEND_MODE,
  networkScope: 'MAINNET_OWNER_APPROVED',
  sourceReference: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_SOURCE_REFERENCE,
  attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
};

export function assertJettonTransferPolicyValid(
  policy: JettonTransferExecutionPolicy,
): void {
  if (policy.attachedTonAtomic < 0n || policy.forwardTonAtomic < 0n) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Jetton transfer policy amounts must be non-negative',
      {
        attachedTonAtomic: policy.attachedTonAtomic.toString(),
        forwardTonAtomic: policy.forwardTonAtomic.toString(),
      },
    );
  }
}

/**
 * Phase 21 Mainnet policy checks:
 * - networkScope must be MAINNET_OWNER_APPROVED (never TESTNET_SPIKE)
 * - forward must be exactly Owner-approved 1 nanogram
 * - attached must be exactly Owner-approved 50_000_000 nanogram
 * - attachedGramLifecycle must be OWNER_APPROVED
 * - SPIKE policy identity (networkScope/sourceReference) is forbidden even if amounts match
 */
export function assertPhase21MainnetTransferPolicy(
  policy: JettonTransferExecutionPolicy,
): void {
  assertJettonTransferPolicyValid(policy);
  if (policy.networkScope !== 'MAINNET_OWNER_APPROVED') {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet cannot use Testnet SPIKE transfer policy',
      { networkScope: policy.networkScope, code: 'SPIKE_POLICY_FORBIDDEN_ON_MAINNET' },
    );
  }
  if (
    policy.sourceReference === PHASE10_TESTNET_SPIKE_TRANSFER_POLICY.sourceReference ||
    policy.sourceReference.trim().toUpperCase().includes('TESTNET_SPIKE') ||
    policy.sourceReference.trim().toUpperCase().includes('PHASE10_TESTNET_SPIKE')
  ) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet must not use SPIKE/Testnet transfer policy sourceReference',
      {
        code: 'SPIKE_ATTACHED_FORBIDDEN_ON_MAINNET',
        sourceReference: policy.sourceReference,
      },
    );
  }
  if (policy.forwardTonAtomic !== PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet forwardTonAtomic must be Owner-approved 1 nanogram',
      {
        code: 'PHASE21_FORWARD_GRAM_ATOMIC_MISMATCH',
        expected: PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC.toString(),
        actual: policy.forwardTonAtomic.toString(),
      },
    );
  }
  const lifecycle = policy.attachedGramLifecycle ?? 'UNVERIFIED';
  if (lifecycle !== 'OWNER_APPROVED' || PHASE21_ATTACHED_GRAM_POLICY_STATUS !== 'OWNER_APPROVED') {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet attached GRAM is not Owner-approved',
      {
        code: 'BLOCKED_OWNER_DECISION_MAINNET_ATTACHED_GRAM',
        attachedGramLifecycle: lifecycle,
        phase21AttachedGramPolicyStatus: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
      },
    );
  }
  if (policy.attachedTonAtomic !== PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet attachedTonAtomic must be Owner-approved 50000000 nanogram (0.05 GRAM)',
      {
        code: 'PHASE21_ATTACHED_GRAM_ATOMIC_MISMATCH',
        expected: PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC.toString(),
        actual: policy.attachedTonAtomic.toString(),
      },
    );
  }
}

export function resolveJettonTransferPolicy(input: {
  readonly phase21MainnetEnabled?: boolean;
  readonly transferPolicy?: JettonTransferExecutionPolicy | null;
}): JettonTransferExecutionPolicy {
  const phase21 = input.phase21MainnetEnabled === true;
  if (!phase21) {
    return PHASE10_TESTNET_SPIKE_TRANSFER_POLICY;
  }
  const policy = input.transferPolicy;
  if (policy === undefined || policy === null) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet requires Owner-approved jetton transfer gas policy',
      { code: 'BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY' },
    );
  }
  assertPhase21MainnetTransferPolicy(policy);
  return policy;
}

/** True when Phase21 source has Owner-approved forward=1 nanogram. */
export function isPhase21ForwardGramPolicySourceReady(): boolean {
  return (
    PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE.forwardTonAtomic ===
    PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC
  );
}

/** True when Phase21 source has Owner-approved attached=50000000 nanogram. */
export function isPhase21AttachedGramPolicySourceReady(): boolean {
  return (
    PHASE21_ATTACHED_GRAM_POLICY_STATUS === 'OWNER_APPROVED' &&
    PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC === 50_000_000n &&
    PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE.attachedTonAtomic ===
      PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC &&
    PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE.attachedGramLifecycle === 'OWNER_APPROVED'
  );
}
