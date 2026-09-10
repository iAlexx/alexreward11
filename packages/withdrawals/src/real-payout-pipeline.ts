import type { Pool } from 'pg';

import type { TonChainProvider } from '@alex-rewards/ton';
import { FakeTonChainProvider } from '@alex-rewards/ton';

import type { WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  assertPhase10Ready,
  listPhase10MissingResources,
  type Phase10PayoutConfig,
} from './phase10-config.js';

export interface RealTestnetPayoutPipelineResult {
  readonly state: 'BLOCKED' | 'PAUSED' | 'READY_SKELETON';
  readonly attemptId: string | null;
  readonly reason?: string;
  readonly missingResources?: readonly string[];
  readonly seqno?: number;
}

export interface RunRealTestnetPayoutPipelineInput {
  readonly withdrawalId: string;
  readonly phase10: Phase10PayoutConfig;
  readonly engine: WithdrawalEngineConfig;
  /**
   * Inject FakeTonChainProvider in unit tests only.
   * Production path requires Owner-complete Phase 10 config + HTTP providers.
   */
  readonly chainProvider?: TonChainProvider;
  /** When true, skip assertPhase10Ready (tests exercising fake provider only). */
  readonly skipAssertReady?: boolean;
}

/**
 * Skeleton real Testnet payout pipeline (Phase 10 foundation).
 *
 * 1. Checks payout pause
 * 2. Fails closed if real chain config incomplete (missing Jetton master, etc.)
 * 3. With FakeTonChainProvider in tests: may fetch seqno for a hot wallet address
 *
 * Does not claim real Testnet 100+ payouts. Does not start Phase 11.
 */
export async function runRealTestnetPayoutPipeline(
  db: Pool,
  input: RunRealTestnetPayoutPipelineInput,
): Promise<RealTestnetPayoutPipelineResult> {
  const paused = await withWithdrawalTransaction(db, async (client) =>
    isPayoutDispatchPaused(client, input.engine.deploymentEnvironment),
  );
  if (paused) {
    return { state: 'PAUSED', attemptId: null, reason: 'PAYOUT_DISPATCH_PAUSE' };
  }

  const provider = input.chainProvider;
  const isFake = provider instanceof FakeTonChainProvider;

  if (!input.skipAssertReady) {
    if (input.phase10.realChainEnabled && input.phase10.jettonMasterIdentity === null) {
      const missing = listPhase10MissingResources(input.phase10);
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        `PHASE10_EXTERNAL_RESOURCE_REQUIRED: ${missing.join(', ')}`,
        {
          details: {
            code: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
            missingResources: missing,
          },
        },
      );
    }
    try {
      assertPhase10Ready(input.phase10);
    } catch (error) {
      if (error instanceof WithdrawalDomainError && error.code === 'EXTERNAL_RESOURCE_REQUIRED') {
        const missing = (error.details?.missingResources as string[] | undefined) ?? [
          error.publicMessage,
        ];
        return {
          state: 'BLOCKED',
          attemptId: null,
          reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
          missingResources: missing,
        };
      }
      throw error;
    }
  }

  if (isFake) {
    const seqno = await provider.getSeqno('EQ_test_hot_wallet');
    return {
      state: 'READY_SKELETON',
      attemptId: null,
      reason: 'fake_provider_seqno_fetched',
      seqno,
    };
  }

  // Real HTTP providers + full attempt/sign/broadcast remain Owner-gated.
  throw new WithdrawalDomainError(
    'EXTERNAL_RESOURCE_REQUIRED',
    'PHASE10_EXTERNAL_RESOURCE_REQUIRED: real Testnet payout path not fully provisioned',
    {
      details: {
        code: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
        missingResources: [
          'Owner-approved Testnet Jetton master',
          'Testnet HTTP providers',
          'Unlocked signer with Hot Wallet identity',
          'Production-shaped attempt with real canonical hash',
        ],
        withdrawalId: input.withdrawalId,
      },
    },
  );
}
