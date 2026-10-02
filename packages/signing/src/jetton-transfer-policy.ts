import { SendMode } from '@ton/core';

import { SignerError } from './errors.js';

/**
 * TESTNET/SPIKE only: attached TON for jetton-wallet gas.
 * Not a production funding / Mainnet default.
 */
export const SPIKE_JETTON_ATTACHED_TON = 50_000_000n; // 0.05 TON

/** TESTNET/SPIKE only: forward TON amount inside jetton transfer body. */
export const SPIKE_JETTON_FORWARD_TON = 1n;

export const SPIKE_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

export interface JettonTransferExecutionPolicy {
  readonly attachedTonAtomic: bigint;
  readonly forwardTonAtomic: bigint;
  readonly sendMode: number;
  readonly networkScope: 'TESTNET_SPIKE' | 'MAINNET_OWNER_APPROVED';
  readonly sourceReference: string;
}

/** Phase 10 / Testnet SPIKE policy - historical attached/forward TON values. */
export const PHASE10_TESTNET_SPIKE_TRANSFER_POLICY: JettonTransferExecutionPolicy = {
  attachedTonAtomic: SPIKE_JETTON_ATTACHED_TON,
  forwardTonAtomic: SPIKE_JETTON_FORWARD_TON,
  sendMode: SPIKE_SEND_MODE,
  networkScope: 'TESTNET_SPIKE',
  sourceReference: 'PHASE10_TESTNET_SPIKE_CONSTANTS',
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
  if (policy.networkScope !== 'MAINNET_OWNER_APPROVED') {
    throw new SignerError(
      'POLICY_REJECTED',
      'Phase 21 Mainnet cannot use Testnet SPIKE transfer policy',
      { networkScope: policy.networkScope },
    );
  }
  assertJettonTransferPolicyValid(policy);
  return policy;
}