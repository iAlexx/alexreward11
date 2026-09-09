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

/**
 * Plain observation shape — NOT a trust boundary.
 * Callers can forge objects matching this interface; reconciliation must not
 * treat them as authoritative without provenance + attempt binding.
 */
export interface FakePayoutObservation {
  readonly phase: FakeBroadcastPhase;
  readonly queryId: bigint;
  readonly recipientAddress: string;
  readonly amountAtomic: string;
  readonly assetSymbol: string;
  readonly correlationReference: string;
  readonly mayHaveBroadcast: boolean;
}

/** Module-private provenance brand — cannot be forged by plain object literals. */
const AUTHORITATIVE_PROVENANCE = Symbol.for('alex-rewards.fake-chain.authoritative-observation');
const AUTHORITATIVE_TOKEN = Object.freeze({ source: 'FakePayoutChain' as const });

/**
 * Observation produced only by the trusted FakePayoutChain (or test stamp helper).
 * Carries immutable payout-intent identity for reconciliation binding.
 */
export interface AuthoritativePayoutObservation extends FakePayoutObservation {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly canonicalMessageHash: string;
  readonly [AUTHORITATIVE_PROVENANCE]: typeof AUTHORITATIVE_TOKEN;
}

export function isAuthoritativePayoutObservation(
  value: unknown,
): value is AuthoritativePayoutObservation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<PropertyKey, unknown>;
  return record[AUTHORITATIVE_PROVENANCE] === AUTHORITATIVE_TOKEN;
}

export function fakeCorrelationReference(withdrawalId: string, attemptNumber: number): string {
  return `fake:${withdrawalId}:${attemptNumber}`;
}

/**
 * Trusted chain-adapter surface for reconciliation.
 * Runtime reconcile asks the adapter; it never accepts caller-built observations.
 */
export interface PayoutChainAdapter {
  /**
   * Return the current observation for the exact withdrawal/attempt pair, or null.
   * Implementations MUST fail closed / return null when the pair is unknown or mismatched.
   */
  observeForAttempt(input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
  }): AuthoritativePayoutObservation | null;
}

function stamp(
  intent: FakePayoutIntent,
  observation: FakePayoutObservation,
): AuthoritativePayoutObservation {
  return {
    ...observation,
    withdrawalId: intent.withdrawalId,
    attemptId: intent.attemptId,
    canonicalMessageHash: intent.canonicalMessageHash,
    [AUTHORITATIVE_PROVENANCE]: AUTHORITATIVE_TOKEN,
  };
}

/**
 * Deterministic LOCAL/TEST fake payout adapter.
 * Impossible to enable in staging/production via config validation.
 * Client cannot choose outcomes — scenario is server/test harness controlled.
 */
export class FakePayoutChain implements PayoutChainAdapter {
  readonly #config: WithdrawalEngineConfig;
  readonly #byAttempt = new Map<
    string,
    { intent: FakePayoutIntent; observation: AuthoritativePayoutObservation }
  >();

  constructor(config: WithdrawalEngineConfig) {
    assertWithdrawalEngineConfig(config);
    if (!config.fakeChainEnabled) {
      throw new WithdrawalDomainError('CONFIG', 'Fake payout chain is disabled');
    }
    this.#config = config;
  }

  registerIntent(intent: FakePayoutIntent): AuthoritativePayoutObservation {
    if (!this.#config.fakeChainEnabled) {
      throw new WithdrawalDomainError('CONFIG', 'Fake payout chain is disabled');
    }
    const observation = stamp(intent, initialObservation(intent));
    this.#byAttempt.set(intent.attemptId, { intent, observation });
    return observation;
  }

  /** Advance according to scenario; never treats unknown as failure. */
  advance(attemptId: string): AuthoritativePayoutObservation {
    const row = this.#byAttempt.get(attemptId);
    if (row === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Unknown fake payout attempt');
    }
    const next = stamp(row.intent, advanceScenario(row.intent.scenario, row.observation));
    const updated = { ...row, observation: next };
    this.#byAttempt.set(attemptId, updated);
    return next;
  }

  observe(attemptId: string): AuthoritativePayoutObservation | null {
    return this.#byAttempt.get(attemptId)?.observation ?? null;
  }

  /** Reconciliation view — returns current observation without mutating. */
  reconcileView(attemptId: string): AuthoritativePayoutObservation | null {
    return this.observe(attemptId);
  }

  observeForAttempt(input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
  }): AuthoritativePayoutObservation | null {
    const row = this.#byAttempt.get(input.attemptId);
    if (row === undefined) return null;
    if (row.intent.withdrawalId !== input.withdrawalId) return null;
    if (row.observation.withdrawalId !== input.withdrawalId) return null;
    if (row.observation.attemptId !== input.attemptId) return null;
    return row.observation;
  }
}

/**
 * TEST-ONLY: stamp an observation with adapter provenance.
 * Not re-exported from the package index — import from this module in tests only.
 */
export function stampAuthoritativeObservationForTests(
  input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
    readonly canonicalMessageHash: string;
  } & FakePayoutObservation,
): AuthoritativePayoutObservation {
  return {
    phase: input.phase,
    queryId: input.queryId,
    recipientAddress: input.recipientAddress,
    amountAtomic: input.amountAtomic,
    assetSymbol: input.assetSymbol,
    correlationReference: input.correlationReference,
    mayHaveBroadcast: input.mayHaveBroadcast,
    withdrawalId: input.withdrawalId,
    attemptId: input.attemptId,
    canonicalMessageHash: input.canonicalMessageHash,
    [AUTHORITATIVE_PROVENANCE]: AUTHORITATIVE_TOKEN,
  };
}

function initialObservation(intent: FakePayoutIntent): FakePayoutObservation {
  const base = {
    queryId: intent.queryId,
    recipientAddress: intent.recipientAddress,
    amountAtomic: intent.netAmountAtomic,
    assetSymbol: intent.assetSymbol,
    correlationReference: fakeCorrelationReference(intent.withdrawalId, intent.attemptNumber),
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
