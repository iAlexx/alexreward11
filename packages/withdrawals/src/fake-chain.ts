import { assertWithdrawalEngineConfig, type WithdrawalEngineConfig } from './config.js';
import { WithdrawalDomainError } from './errors.js';

export type FakePayoutScenario =
  | 'CONFIRMED_SUCCESS'
  | 'DEFINITE_PRE_BROADCAST_FAILURE'
  | 'BROADCAST_ACCEPTED_THEN_CONFIRM'
  | 'BROADCAST_RESULT_UNKNOWN'
  | 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION'
  | 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT'
  | 'CONFIRMATION_DELAY'
  | 'CRASH_BEFORE_POSSIBLE_BROADCAST'
  | 'CRASH_AFTER_POSSIBLE_BROADCAST';

export type FakeBroadcastPhase =
  | 'NOT_STARTED'
  | 'PRE_BROADCAST_FAILED'
  | 'POSSIBLE_BROADCAST'
  | 'ACCEPTED'
  | 'CONFIRMED'
  | 'DEFINITIVE_NONPAYMENT'
  | 'UNKNOWN';

export interface FakePayoutIntent {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly hotWalletId: string;
  readonly recipientAddress: string;
  readonly assetSymbol: string;
  readonly netAmountAtomic: string;
  readonly queryId: bigint;
  readonly canonicalMessageHash: string;
  readonly scenario: FakePayoutScenario;
}

export interface FakePayoutObservation {
  readonly phase: FakeBroadcastPhase;
  readonly queryId: bigint;
  readonly recipientAddress: string;
  readonly amountAtomic: string;
  readonly assetSymbol: string;
  readonly correlationReference: string;
  readonly mayHaveBroadcast: boolean;
}

/**
 * Deterministic LOCAL/TEST fake payout adapter.
 * Impossible to enable in staging/production via config validation.
 * Client cannot choose outcomes — scenario is server/test harness controlled.
 */
export class FakePayoutChain {
  readonly #config: WithdrawalEngineConfig;
  readonly #byAttempt = new Map<
    string,
    { intent: FakePayoutIntent; observation: FakePayoutObservation }
  >();

  constructor(config: WithdrawalEngineConfig) {
    assertWithdrawalEngineConfig(config);
    if (!config.fakeChainEnabled) {
      throw new WithdrawalDomainError('CONFIG', 'Fake payout chain is disabled');
    }
    this.#config = config;
  }

  registerIntent(intent: FakePayoutIntent): FakePayoutObservation {
    if (!this.#config.fakeChainEnabled) {
      throw new WithdrawalDomainError('CONFIG', 'Fake payout chain is disabled');
    }
    const observation = initialObservation(intent);
    this.#byAttempt.set(intent.attemptId, { intent, observation });
    return observation;
  }

  /** Advance according to scenario; never treats unknown as failure. */
  advance(attemptId: string): FakePayoutObservation {
    const row = this.#byAttempt.get(attemptId);
    if (row === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Unknown fake payout attempt');
    }
    const next = advanceScenario(row.intent.scenario, row.observation);
    const updated = { ...row, observation: next };
    this.#byAttempt.set(attemptId, updated);
    return next;
  }

  observe(attemptId: string): FakePayoutObservation | null {
    return this.#byAttempt.get(attemptId)?.observation ?? null;
  }

  /** Reconciliation view — returns current observation without mutating. */
  reconcileView(attemptId: string): FakePayoutObservation | null {
    return this.observe(attemptId);
  }
}

function initialObservation(intent: FakePayoutIntent): FakePayoutObservation {
  const base = {
    queryId: intent.queryId,
    recipientAddress: intent.recipientAddress,
    amountAtomic: intent.netAmountAtomic,
    assetSymbol: intent.assetSymbol,
    correlationReference: `fake:${intent.withdrawalId}:${intent.attemptNumber}`,
  };
  switch (intent.scenario) {
    case 'DEFINITE_PRE_BROADCAST_FAILURE':
    case 'CRASH_BEFORE_POSSIBLE_BROADCAST':
      return { ...base, phase: 'PRE_BROADCAST_FAILED', mayHaveBroadcast: false };
    case 'CONFIRMED_SUCCESS':
      return { ...base, phase: 'CONFIRMED', mayHaveBroadcast: true };
    case 'BROADCAST_ACCEPTED_THEN_CONFIRM':
      return { ...base, phase: 'ACCEPTED', mayHaveBroadcast: true };
    case 'BROADCAST_RESULT_UNKNOWN':
    case 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION':
    case 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT':
    case 'CRASH_AFTER_POSSIBLE_BROADCAST':
    case 'CONFIRMATION_DELAY':
      return { ...base, phase: 'UNKNOWN', mayHaveBroadcast: true };
    default:
      return { ...base, phase: 'NOT_STARTED', mayHaveBroadcast: false };
  }
}

function advanceScenario(
  scenario: FakePayoutScenario,
  current: FakePayoutObservation,
): FakePayoutObservation {
  if (scenario === 'BROADCAST_ACCEPTED_THEN_CONFIRM' && current.phase === 'ACCEPTED') {
    return { ...current, phase: 'CONFIRMED', mayHaveBroadcast: true };
  }
  if (scenario === 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION' && current.phase === 'UNKNOWN') {
    return { ...current, phase: 'CONFIRMED', mayHaveBroadcast: true };
  }
  if (scenario === 'UNKNOWN_THEN_DEFINITIVE_NONPAYMENT' && current.phase === 'UNKNOWN') {
    return { ...current, phase: 'DEFINITIVE_NONPAYMENT', mayHaveBroadcast: true };
  }
  if (scenario === 'CONFIRMATION_DELAY' && current.phase === 'UNKNOWN') {
    return { ...current, phase: 'ACCEPTED', mayHaveBroadcast: true };
  }
  return current;
}
