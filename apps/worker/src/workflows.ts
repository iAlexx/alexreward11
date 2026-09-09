import { proxyActivities } from '@temporalio/workflow';

/**
 * Activity contract only — do not import Node/DB modules into the workflow bundle.
 */
export interface WithdrawalPayoutActivities {
  executeWithdrawalFakePayout(input: {
    withdrawalId: string;
  }): Promise<{ state: string; attemptId: string | null }>;
}

const { executeWithdrawalFakePayout } = proxyActivities<WithdrawalPayoutActivities>({
  startToCloseTimeout: '5 minutes',
});

export async function foundationProbe(input: string): Promise<string> {
  return `foundation-ok:${input}`;
}

export async function withdrawalPayoutWorkflow(input: {
  withdrawalId: string;
}): Promise<{ state: string; attemptId: string | null }> {
  return await executeWithdrawalFakePayout(input);
}
