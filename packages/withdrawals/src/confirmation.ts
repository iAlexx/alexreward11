import type { JettonTransferEvidence } from '@alex-rewards/ton';
import { TON_TESTNET_NETWORK_GLOBAL_ID } from '@alex-rewards/ton';

export interface ExpectedJettonPayout {
  readonly hotWallet: string;
  readonly jettonMaster: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly queryId: string;
  /** Required for full Phase 10 confirmation (Testnet only). */
  readonly networkGlobalId?: number;
  /** Expected Hot Wallet Jetton wallet (sender side of TEP-74 transfer). */
  readonly senderJettonWallet?: string;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function addressesEqual(left: string, right: string): boolean {
  return normalizeAddress(left) === normalizeAddress(right);
}

/**
 * Strict match for intended Jetton payout confirmation.
 * Requires hot wallet, master, recipient, exact amount, queryId, success, not bounced.
 * When expected includes network / sender Jetton wallet, those must also match.
 * High-level "JettonTransfer action" labels alone are never sufficient.
 */
export function matchIntendedJettonPayout(
  evidence: JettonTransferEvidence,
  expected: ExpectedJettonPayout,
): boolean {
  if (
    !addressesEqual(evidence.hotWallet, expected.hotWallet) ||
    !addressesEqual(evidence.jettonMaster, expected.jettonMaster) ||
    !addressesEqual(evidence.recipient, expected.recipient) ||
    evidence.amountAtomic !== expected.amountAtomic ||
    evidence.queryId !== expected.queryId ||
    evidence.success !== true ||
    evidence.bounced !== false
  ) {
    return false;
  }

  const expectedNetwork = expected.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID;
  const evidenceNetwork = evidence.networkGlobalId ?? expectedNetwork;
  if (evidenceNetwork !== expectedNetwork || expectedNetwork !== TON_TESTNET_NETWORK_GLOBAL_ID) {
    return false;
  }

  if (expected.senderJettonWallet !== undefined) {
    if (
      evidence.senderJettonWallet === undefined ||
      !addressesEqual(evidence.senderJettonWallet, expected.senderJettonWallet)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Prove primary and secondary evidence agree on the intended payout fields.
 * Disagreement → not confirmed (reconcile required).
 */
export function primarySecondaryEvidenceAgree(
  primary: JettonTransferEvidence,
  secondary: JettonTransferEvidence,
  expected: ExpectedJettonPayout,
): boolean {
  if (!matchIntendedJettonPayout(primary, expected)) return false;
  if (!matchIntendedJettonPayout(secondary, expected)) return false;
  return (
    primary.queryId === secondary.queryId &&
    primary.amountAtomic === secondary.amountAtomic &&
    addressesEqual(primary.recipient, secondary.recipient) &&
    addressesEqual(primary.jettonMaster, secondary.jettonMaster) &&
    addressesEqual(primary.hotWallet, secondary.hotWallet) &&
    primary.success === secondary.success &&
    primary.bounced === secondary.bounced
  );
}

export const confirmation = {
  matchIntendedJettonPayout,
  primarySecondaryEvidenceAgree,
} as const;
