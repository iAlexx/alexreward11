import { assertWithdrawalEngineConfig, type WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { FakePayoutChain, type FakeBroadcastPhase, type FakePayoutScenario } from './fake-chain.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  acquireTestDispatchLease,
  createWithdrawalAttempt,
  updateAttemptBroadcastState,
} from './attempts.js';
import { reconcileWithdrawalAttemptInTxn } from './reconcile.js';
import { settleWithdrawalReservation } from './settlement.js';
import type { WithdrawalState } from './state-machine.js';
import { transitionWithdrawal } from './transitions.js';

export interface FakePayoutPipelineResult {
  readonly withdrawalId: string;
  readonly state: WithdrawalState;
  readonly attemptId: string | null;
  readonly scenario: FakePayoutScenario;
  readonly paused?: boolean;
}

type PipelineInput = {
  readonly withdrawalId: string;
  readonly scenario: FakePayoutScenario;
};

function resolvePipelineArgs(
  config: WithdrawalEngineConfig,
  fakeChainOrId: FakePayoutChain | string,
  inputOrScenario: PipelineInput | FakePayoutScenario,
): { fakeChain: FakePayoutChain; withdrawalId: string; scenario: FakePayoutScenario } {
  if (typeof fakeChainOrId === 'string') {
    return {
      fakeChain: new FakePayoutChain(config),
      withdrawalId: fakeChainOrId,
      scenario: inputOrScenario as FakePayoutScenario,
    };
  }
  const input = inputOrScenario as PipelineInput;
  return {
    fakeChain: fakeChainOrId,
    withdrawalId: input.withdrawalId,
    scenario: input.scenario,
  };
}

/**
 * In-process fake Temporal substitute for LOCAL/TEST.
 *
 * Preferred: runFakePayoutPipeline(db, config, fakeChain, { withdrawalId, scenario })
 * Compat:    runFakePayoutPipeline(db, config, withdrawalId, scenario)
 */
export async function runFakePayoutPipeline(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  fakeChainOrWithdrawalId: FakePayoutChain | string,
  inputOrScenario: PipelineInput | FakePayoutScenario,
): Promise<FakePayoutPipelineResult> {
  assertWithdrawalEngineConfig(config);
  if (!config.fakeChainEnabled) {
    throw new WithdrawalDomainError('CONFIG', 'Fake payout chain is disabled');
  }

  const { fakeChain, withdrawalId, scenario } = resolvePipelineArgs(
    config,
    fakeChainOrWithdrawalId,
    inputOrScenario,
  );

  return withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      id: string;
      state: WithdrawalState;
      hot_wallet_id: string | null;
      wallet_id: string;
      net_amount_atomic: string;
      asset_id: string;
      held_from_reconcile: boolean;
    }>(
      `SELECT w.id, w.state, w.hot_wallet_id, w.wallet_id, w.net_amount_atomic::text,
              w.asset_id, w.held_from_reconcile
       FROM withdrawals w
       WHERE w.id = $1::uuid
       FOR UPDATE`,
      [withdrawalId],
    );
    const w = locked.rows[0];
    if (w === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }
    if (w.hot_wallet_id === null) {
      throw new WithdrawalDomainError('CONFIG', 'Hot wallet missing on withdrawal');
    }

    if (await isPayoutDispatchPaused(client, config.deploymentEnvironment)) {
      // Leave pending / move to HELD — do not dispatch.
      if (w.state === 'APPROVED' || w.state === 'QUEUED') {
        if (w.state === 'APPROVED') {
          await transitionWithdrawal(client, {
            id: w.id,
            from: 'APPROVED',
            to: 'HELD',
          });
        } else {
          await transitionWithdrawal(client, {
            id: w.id,
            from: 'QUEUED',
            to: 'HELD',
          });
        }
        return {
          withdrawalId: w.id,
          state: 'HELD',
          attemptId: null,
          scenario,
          paused: true,
        };
      }
      return {
        withdrawalId: w.id,
        state: w.state,
        attemptId: null,
        scenario,
        paused: true,
      };
    }

    let state = w.state;
    if (state === 'APPROVED') {
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'APPROVED',
        to: 'QUEUED',
      });
      state = 'QUEUED';
    }
    if (state === 'FAILED_PRE_BROADCAST') {
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'FAILED_PRE_BROADCAST',
        to: 'QUEUED',
      });
      state = 'QUEUED';
    }
    if (state !== 'QUEUED') {
      throw new WithdrawalDomainError('STATE_CONFLICT', 'Pipeline expects APPROVED/QUEUED', {
        details: { state },
      });
    }

    const wallet = await client.query<{ raw_address: string; friendly_address: string }>(
      `SELECT raw_address, friendly_address FROM user_wallets WHERE id = $1::uuid`,
      [w.wallet_id],
    );
    const recipient = wallet.rows[0]?.friendly_address ?? wallet.rows[0]?.raw_address ?? '';
    if (recipient === '') {
      throw new WithdrawalDomainError('WALLET_INELIGIBLE', 'Recipient wallet missing');
    }

    const hot = await client.query<{ signer_reference: string }>(
      `SELECT signer_reference FROM hot_wallets WHERE id = $1::uuid`,
      [w.hot_wallet_id],
    );
    const signerRef = hot.rows[0]?.signer_reference ?? 'TEST_ONLY_FAKE';

    await transitionWithdrawal(client, { id: w.id, from: 'QUEUED', to: 'SIGNING' });

    const lease = await acquireTestDispatchLease(
      client,
      w.hot_wallet_id,
      `phase7-fake-pipeline:${w.id}`,
    );

    const attempt = await createWithdrawalAttempt(client, {
      withdrawalId: w.id,
      hotWalletId: w.hot_wallet_id,
      fencingToken: lease.fencingToken,
      signerKeyReference: signerRef,
      scenarioHashInputs: { scenario, recipient },
    });

    const observation = fakeChain.registerIntent({
      withdrawalId: w.id,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      hotWalletId: w.hot_wallet_id,
      recipientAddress: recipient,
      assetSymbol: config.usdtSymbol,
      netAmountAtomic: w.net_amount_atomic,
      queryId: BigInt(attempt.queryId),
      canonicalMessageHash: attempt.canonicalMessageHash,
      scenario,
    });

    if (
      observation.phase === 'PRE_BROADCAST_FAILED' ||
      scenario === 'DEFINITE_PRE_BROADCAST_FAILURE' ||
      scenario === 'CRASH_BEFORE_POSSIBLE_BROADCAST'
    ) {
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'FAILED_PRE_BROADCAST',
        // no broadcast_started_at
      });
      return {
        withdrawalId: w.id,
        state: 'FAILED_PRE_BROADCAST',
        attemptId: attempt.id,
        scenario,
      };
    }

    await transitionWithdrawal(client, {
      id: w.id,
      from: 'SIGNING',
      to: 'BROADCASTING',
    });

    // UNKNOWN / mayHaveBroadcast → RECONCILE_REQUIRED (NEVER release reserved)
    if (
      observation.phase === 'UNKNOWN' ||
      scenario === 'BROADCAST_RESULT_UNKNOWN' ||
      scenario === 'CRASH_AFTER_POSSIBLE_BROADCAST' ||
      scenario === 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION' ||
      scenario === 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT' ||
      scenario === 'CONFIRMATION_DELAY'
    ) {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'UNKNOWN',
        markBroadcastStarted: true,
        chainReference: observation.correlationReference,
      });
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'BROADCASTING',
        to: 'RECONCILE_REQUIRED',
      });
      return {
        withdrawalId: w.id,
        state: 'RECONCILE_REQUIRED',
        attemptId: attempt.id,
        scenario,
      };
    }

    // Accepted / confirmed path
    await updateAttemptBroadcastState(client, {
      attemptId: attempt.id,
      broadcastResultState: 'BROADCASTED',
      markBroadcastStarted: true,
      chainReference: observation.correlationReference,
    });
    await transitionWithdrawal(client, {
      id: w.id,
      from: 'BROADCASTING',
      to: 'BROADCASTED',
    });
    await transitionWithdrawal(client, {
      id: w.id,
      from: 'BROADCASTED',
      to: 'CONFIRMING',
    });

    let phase: FakeBroadcastPhase = observation.phase;
    if (phase === 'ACCEPTED') {
      phase = fakeChain.advance(attempt.id).phase;
    }

    if (phase === 'CONFIRMED') {
      // Transition to CONFIRMED then settle in SAME transaction (idempotent).
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'CONFIRMING',
        to: 'CONFIRMED',
      });
      await settleWithdrawalReservation(client, { withdrawalId: w.id });
      return {
        withdrawalId: w.id,
        state: 'CONFIRMED',
        attemptId: attempt.id,
        scenario,
      };
    }

    await transitionWithdrawal(client, {
      id: w.id,
      from: 'CONFIRMING',
      to: 'RECONCILE_REQUIRED',
    });
    await updateAttemptBroadcastState(client, {
      attemptId: attempt.id,
      broadcastResultState: 'RECONCILE_REQUIRED',
    });
    return {
      withdrawalId: w.id,
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      scenario,
    };
  });
}

type AdvanceInput = {
  readonly withdrawalId: string;
  readonly attemptId?: string;
  readonly scenario?: FakePayoutScenario;
};

/**
 * Advance fake reconciliation for a RECONCILE_REQUIRED (or continue) withdrawal.
 *
 * Preferred: advanceFakeReconciliation(db, config, fakeChain, { withdrawalId })
 * Compat:    advanceFakeReconciliation(db, config, { withdrawalId, attemptId, scenario })
 */
export async function advanceFakeReconciliation(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  fakeChainOrInput: FakePayoutChain | AdvanceInput,
  maybeInput?: AdvanceInput,
): Promise<FakePayoutPipelineResult> {
  assertWithdrawalEngineConfig(config);

  let fakeChain: FakePayoutChain;
  let input: AdvanceInput;
  if (fakeChainOrInput instanceof FakePayoutChain) {
    fakeChain = fakeChainOrInput;
    if (maybeInput === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'advanceFakeReconciliation input required');
    }
    input = maybeInput;
  } else {
    fakeChain = new FakePayoutChain(config);
    input = fakeChainOrInput;
  }

  return withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      id: string;
      state: WithdrawalState;
      net_amount_atomic: string;
      wallet_id: string;
      hot_wallet_id: string | null;
    }>(
      `SELECT id, state, net_amount_atomic::text, wallet_id, hot_wallet_id
       FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
      [input.withdrawalId],
    );
    const withdrawal = locked.rows[0];
    if (withdrawal === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }

    let attemptId = input.attemptId;
    if (attemptId === undefined) {
      const live = await client.query<{ id: string }>(
        `SELECT id FROM withdrawal_attempts
         WHERE withdrawal_id = $1::uuid
           AND broadcast_result_state IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED')
         ORDER BY attempt_number DESC
         LIMIT 1`,
        [input.withdrawalId],
      );
      attemptId = live.rows[0]?.id;
      if (attemptId === undefined) {
        throw new WithdrawalDomainError('VALIDATION', 'No reconcile attempt found');
      }
    }

    const attempt = await client.query<{
      id: string;
      query_id: string;
      attempt_number: number;
      hot_wallet_id: string;
      canonical_message_hash: string;
    }>(
      `SELECT id, query_id::text, attempt_number, hot_wallet_id, canonical_message_hash
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [attemptId],
    );
    const a = attempt.rows[0];
    if (a === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
    }

    const wallet = await client.query<{ friendly_address: string; raw_address: string }>(
      `SELECT friendly_address, raw_address FROM user_wallets WHERE id = $1::uuid`,
      [withdrawal.wallet_id],
    );
    const recipient = wallet.rows[0]?.friendly_address ?? wallet.rows[0]?.raw_address ?? 'unknown';

    const scenario = input.scenario ?? 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION';

    // Ensure chain has intent (ephemeral chain per call in compat mode).
    if (fakeChain.observe(a.id) === null) {
      fakeChain.registerIntent({
        withdrawalId: input.withdrawalId,
        attemptId: a.id,
        attemptNumber: a.attempt_number,
        hotWalletId: a.hot_wallet_id,
        recipientAddress: recipient,
        assetSymbol: config.usdtSymbol,
        netAmountAtomic: withdrawal.net_amount_atomic,
        queryId: BigInt(a.query_id),
        canonicalMessageHash: a.canonical_message_hash,
        scenario,
      });
    }
    const advanced = fakeChain.advance(a.id);

    if (advanced.phase === 'CONFIRMED') {
      const result = await reconcileWithdrawalAttemptInTxn(client, config, {
        withdrawalId: input.withdrawalId,
        attemptId: a.id,
        observation: advanced,
      });
      return {
        withdrawalId: input.withdrawalId,
        state: result.state,
        attemptId: a.id,
        scenario,
      };
    }

    if (advanced.phase === 'DEFINITIVE_NONPAYMENT') {
      const result = await reconcileWithdrawalAttemptInTxn(client, config, {
        withdrawalId: input.withdrawalId,
        attemptId: a.id,
        observation: advanced,
        forceResolution: 'DEFINITIVE_NONPAYMENT',
      });
      return {
        withdrawalId: input.withdrawalId,
        state: result.state,
        attemptId: a.id,
        scenario,
      };
    }

    const result = await reconcileWithdrawalAttemptInTxn(client, config, {
      withdrawalId: input.withdrawalId,
      attemptId: a.id,
      observation: advanced,
      forceResolution: 'AMBIGUOUS',
    });
    return {
      withdrawalId: input.withdrawalId,
      state: result.state,
      attemptId: a.id,
      scenario,
    };
  });
}
