import type { JettonTransferEvidence } from '@alex-rewards/ton';

export interface ExpectedJettonPayout {
  readonly hotWallet: string;
  readonly jettonMaster: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly queryId: string;
}

/**
 * Strict match for intended Jetton payout confirmation.
 * Requires hot wallet, master, recipient, exact amount, queryId, success, not bounced.
 */
export function matchIntendedJettonPayout(
  evidence: JettonTransferEvidence,
  expected: ExpectedJettonPayout,
): boolean {
  return (
    evidence.hotWallet === expected.hotWallet &&
    evidence.jettonMaster === expected.jettonMaster &&
    evidence.recipient === expected.recipient &&
    evidence.amountAtomic === expected.amountAtomic &&
    evidence.queryId === expected.queryId &&
    evidence.success === true &&
    evidence.bounced === false
  );
}

export const confirmation = {
  matchIntendedJettonPayout,
} as const;
