import type { Pool } from 'pg';

import {
  FakePayoutChain,
  assertPhase10Ready,
  buildPhase10PayoutConfig,
  runFakePayoutPipeline,
  runRealTestnetPayoutPipeline,
  takeFakePayoutScenario,
  type Phase10PayoutConfig,
  type WithdrawalEngineConfig,
  WithdrawalDomainError,
} from '@alex-rewards/withdrawals';

export interface WithdrawalActivityDeps {
  readonly pool: Pool;
  readonly config: WithdrawalEngineConfig;
  readonly phase10?: Phase10PayoutConfig;
}

/**
 * Temporal activities for withdrawal payout. Mutations live here (not in workflows).
 * Fake chain is LOCAL/TEST only — fail closed when disabled.
 * Real Testnet path is Phase 10 foundation (fail closed until Owner resources exist).
 */
export function createWithdrawalActivities(deps: WithdrawalActivityDeps) {
  const phase10 =
    deps.phase10 ??
    buildPhase10PayoutConfig({
      realChainEnabled: false,
    });

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

    /**
     * Phase 10 Testnet payout activity. Fail-closed until Owner resources exist.
     * Does not run real Testnet broadcasts without WITHDRAWAL_REAL_CHAIN_ENABLED + providers.
     */
    async executeWithdrawalTestnetPayout(input: {
      withdrawalId: string;
    }): Promise<{ state: string; attemptId: string | null }> {
      if (deps.config.fakeChainEnabled) {
        throw new Error('Testnet payout activity forbidden while fake chain is enabled');
      }
      if (!phase10.realChainEnabled) {
        throw new WithdrawalDomainError(
          'EXTERNAL_RESOURCE_REQUIRED',
          'PHASE10_EXTERNAL_RESOURCE_REQUIRED: WITHDRAWAL_REAL_CHAIN_ENABLED=false',
          {
            details: {
              code: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
              missingResources: ['WITHDRAWAL_REAL_CHAIN_ENABLED=true'],
            },
          },
        );
      }
      assertPhase10Ready(phase10);
      const result = await runRealTestnetPayoutPipeline(deps.pool, {
        withdrawalId: input.withdrawalId,
        phase10,
        engine: deps.config,
      });
      return {
        state: result.state,
        attemptId: result.attemptId,
      };
    },
  };
}

export type WithdrawalActivities = ReturnType<typeof createWithdrawalActivities>;
