import { proxyActivities } from '@temporalio/workflow';

/**
 * Activity contract only — do not import Node/DB modules into the workflow bundle.
 *
 * Phase 10: optional Testnet activity selected by input.realChainEnabled.
 * Default remains Phase 7 fake payout when realChainEnabled is not true
 * (preserves existing fake-chain Temporal tests).
 */
export interface WithdrawalPayoutActivities {
  executeWithdrawalFakePayout(input: {
    withdrawalId: string;
  }): Promise<{ state: string; attemptId: string | null }>;
  executeWithdrawalTestnetPayout(input: {
    withdrawalId: string;
  }): Promise<{ state: string; attemptId: string | null }>;
}

const { executeWithdrawalFakePayout, executeWithdrawalTestnetPayout } =
  proxyActivities<WithdrawalPayoutActivities>({
    startToCloseTimeout: '5 minutes',
  });

export async function foundationProbe(input: string): Promise<string> {
  return `foundation-ok:${input}`;
}

export async function withdrawalPayoutWorkflow(input: {
  withdrawalId: string;
  /** When true and fake chain disabled, use Phase 10 Testnet activity. */
  realChainEnabled?: boolean;
}): Promise<{ state: string; attemptId: string | null }> {
  if (input.realChainEnabled === true) {
    return await executeWithdrawalTestnetPayout({ withdrawalId: input.withdrawalId });
  }
  return await executeWithdrawalFakePayout({ withdrawalId: input.withdrawalId });
}
