import type { Pool } from 'pg';

import {
  FakePayoutChain,
  runFakePayoutPipeline,
  takeFakePayoutScenario,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

export interface WithdrawalActivityDeps {
  readonly pool: Pool;
  readonly config: WithdrawalEngineConfig;
}

/**
 * Temporal activities for withdrawal payout. Mutations live here (not in workflows).
 * Fake chain is LOCAL/TEST only — fail closed when disabled.
 */
export function createWithdrawalActivities(deps: WithdrawalActivityDeps) {
  return {
    async executeWithdrawalFakePayout(input: {
      withdrawalId: string;
    }): Promise<{ state: string; attemptId: string | null }> {
      if (!deps.config.fakeChainEnabled) {
        throw new Error('Fake payout chain is disabled');
      }
      const scenario = takeFakePayoutScenario(input.withdrawalId);
      const fakeChain = new FakePayoutChain(deps.config);
      const result = await runFakePayoutPipeline(deps.pool, deps.config, fakeChain, {
        withdrawalId: input.withdrawalId,
        scenario,
      });
      return {
        state: result.state,
        attemptId: result.attemptId,
      };
    },
  };
}

export type WithdrawalActivities = ReturnType<typeof createWithdrawalActivities>;
