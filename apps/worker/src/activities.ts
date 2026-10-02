import type { Pool } from 'pg';

import { buildCanonicalSigningMessageAsync } from '@alex-rewards/signing';
import {
  FakePayoutChain,
  assertPhase10Ready,
  assertPhase21Ready,
  buildPhase10PayoutConfig,
  runFakePayoutPipeline,
  runRealTestnetPayoutPipeline,
  takeFakePayoutScenario,
  type Phase10PayoutConfig,
  type Phase21PayoutConfig,
  type WithdrawalEngineConfig,
  type WithdrawalPayoutAuthority,
  WithdrawalDomainError,
} from '@alex-rewards/withdrawals';

import {
  toWithdrawalPayoutActivityResult,
  type WithdrawalPayoutActivityResult,
} from './payout-activity-result.js';

export type { WithdrawalPayoutActivityResult } from './payout-activity-result.js';

export interface WithdrawalActivityDeps {
  readonly pool: Pool;
  readonly config: WithdrawalEngineConfig;
  readonly payoutAuthority?: WithdrawalPayoutAuthority;
  readonly phase10?: Phase10PayoutConfig;
  readonly phase21?: Phase21PayoutConfig;
}

/**
 * Temporal activities for withdrawal payout. Mutations live here (not in workflows).
 * Fake chain is LOCAL/TEST only — fail closed when disabled.
 * Real Testnet path is Phase 10 foundation (fail closed until Owner resources exist).
 * Phase 21 Mainnet path requires explicit PHASE21_MAINNET_ENABLED worker wiring.
 */
export function createWithdrawalActivities(deps: WithdrawalActivityDeps) {
  const payoutAuthority = deps.payoutAuthority ?? 'PHASE10_TESTNET';
  const phase10 =
    deps.phase10 ??
    buildPhase10PayoutConfig({
      realChainEnabled: false,
    });
  const phase21 = deps.phase21;

  return {
    async executeWithdrawalFakePayout(input: {
      withdrawalId: string;
    }): Promise<WithdrawalPayoutActivityResult> {
      if (!deps.config.fakeChainEnabled) {
        throw new Error('Fake payout chain is disabled');
      }
      const scenario = takeFakePayoutScenario(input.withdrawalId);
      const fakeChain = new FakePayoutChain(deps.config);
      const result = await runFakePayoutPipeline(deps.pool, deps.config, fakeChain, {
        withdrawalId: input.withdrawalId,
        scenario,
      });
      return toWithdrawalPayoutActivityResult(result);
    },

    /**
     * Phase 10 Testnet / Phase 21 Mainnet payout activity.
     * Fail-closed until Owner resources exist. Preserves pipeline diagnostics.
     */
    async executeWithdrawalTestnetPayout(input: {
      withdrawalId: string;
    }): Promise<WithdrawalPayoutActivityResult> {
      if (deps.config.fakeChainEnabled) {
        throw new Error('Real payout activity forbidden while fake chain is enabled');
      }

      const isMainnet = payoutAuthority === 'PHASE21_MAINNET';
      const realChainEnabled = isMainnet
        ? phase21?.realChainEnabled === true
        : phase10.realChainEnabled;

      if (!realChainEnabled) {
        throw new WithdrawalDomainError(
          'EXTERNAL_RESOURCE_REQUIRED',
          isMainnet
            ? 'PHASE21_EXTERNAL_RESOURCE_REQUIRED: WITHDRAWAL_REAL_CHAIN_ENABLED=false'
            : 'PHASE10_EXTERNAL_RESOURCE_REQUIRED: WITHDRAWAL_REAL_CHAIN_ENABLED=false',
          {
            details: {
              code: isMainnet
                ? 'PHASE21_EXTERNAL_RESOURCE_REQUIRED'
                : 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
              missingResources: ['WITHDRAWAL_REAL_CHAIN_ENABLED=true'],
            },
          },
        );
      }

      if (isMainnet) {
        if (phase21 === undefined) {
          throw new WithdrawalDomainError(
            'CONFIG',
            'Phase 21 Mainnet payout requires phase21 worker config',
          );
        }
        assertPhase21Ready(phase21);
      } else {
        assertPhase10Ready(phase10);
      }

      const pipelineInput = {
        withdrawalId: input.withdrawalId,
        engine: deps.config,
        buildCanonicalMessageHash: async (intent: Parameters<
          typeof buildCanonicalSigningMessageAsync
        >[0]) => {
          const built = await buildCanonicalSigningMessageAsync(intent, {
            phase21MainnetEnabled: isMainnet,
          });
          return built.canonicalMessageHashHex;
        },
        ...(isMainnet && phase21 !== undefined ? { phase21 } : {}),
        ...(!isMainnet ? { phase10 } : {}),
      };
      const result = await runRealTestnetPayoutPipeline(deps.pool, pipelineInput);
      return toWithdrawalPayoutActivityResult(result);
    },
  };
}

export type WithdrawalActivities = ReturnType<typeof createWithdrawalActivities>;
