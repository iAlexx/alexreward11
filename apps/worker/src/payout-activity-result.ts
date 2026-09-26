/**
 * Maps real/fake payout pipeline results to the Temporal activity/workflow result shape.
 * Preserves diagnostic `reason` and `stagesCompleted` for FAILED_PRE / blocked paths.
 */

export interface WithdrawalPayoutActivityResult {
  readonly state: string;
  readonly attemptId: string | null;
  readonly reason?: string;
  readonly stagesCompleted?: readonly string[];
}

export interface PayoutPipelineResultLike {
  readonly state: string;
  readonly attemptId: string | null;
  readonly reason?: string;
  readonly stagesCompleted?: readonly string[];
}

export function toWithdrawalPayoutActivityResult(
  result: PayoutPipelineResultLike,
): WithdrawalPayoutActivityResult {
  return {
    state: result.state,
    attemptId: result.attemptId,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.stagesCompleted !== undefined
      ? { stagesCompleted: [...result.stagesCompleted] }
      : {}),
  };
}
