import { AD_SESSION_STATE_RANK, TERMINAL_AD_SESSION_STATES } from '../constants.js';
import type { AdSessionState, AdSessionSignalRecord, AdSignalType } from '../types.js';

export type SessionDerivationReason =
  | 'TERMINAL_STATE_IMMUTABLE'
  | 'EVIDENCE_ONLY_NO_FORWARD_TRANSITION'
  | 'OUT_OF_ORDER_EVIDENCE_RECORDED'
  | 'EVIDENCE_WINDOW_EXPIRED'
  | 'CLIENT_EVIDENCE_ALONE_INSUFFICIENT'
  | 'PROVIDER_EVIDENCE_NOT_CORRELATED'
  | 'DERIVED_FROM_EVIDENCE';

export interface DeriveSessionStateInput {
  readonly currentState: AdSessionState;
  readonly signals: readonly AdSessionSignalRecord[];
  readonly expiresAt: Date;
  readonly asOf: Date;
  /** Domain facts that evidence alone cannot prove. */
  readonly quoteCommitted: boolean;
  readonly authorizationPassed: boolean;
  readonly verificationPassed: boolean;
  readonly rewardCommitted: boolean;
}

export interface DeriveSessionStateResult {
  readonly state: AdSessionState;
  readonly previousState: AdSessionState;
  readonly changed: boolean;
  readonly terminal: boolean;
  /** True when new evidence was recorded but the authoritative state must not move. */
  readonly evidenceOnly: boolean;
  readonly reasonCodes: readonly SessionDerivationReason[];
}

export function isTerminalAdSessionState(state: AdSessionState): boolean {
  return TERMINAL_AD_SESSION_STATES.has(state);
}

function hasSignal(signals: readonly AdSessionSignalRecord[], type: AdSignalType): boolean {
  return signals.some((signal) => signal.signalType === type);
}

function hasCorrelatedProviderConfirmation(signals: readonly AdSessionSignalRecord[]): boolean {
  return signals.some(
    (signal) =>
      signal.signalType === 'PROVIDER_CONFIRMATION' &&
      signal.source === 'PROVIDER' &&
      signal.correlation === 'CORRELATED' &&
      signal.authenticity !== 'REJECTED',
  );
}

function hasProviderConfirmationEvidence(signals: readonly AdSessionSignalRecord[]): boolean {
  return signals.some(
    (signal) => signal.signalType === 'PROVIDER_CONFIRMATION' && signal.source === 'PROVIDER',
  );
}

function hasClientCompletion(signals: readonly AdSessionSignalRecord[]): boolean {
  return signals.some(
    (signal) => signal.signalType === 'CLIENT_COMPLETION' && signal.authenticity !== 'REJECTED',
  );
}

/**
 * Derive the authoritative session state from append-only evidence plus domain decisions
 * (Spec V1.3 §18).
 *
 * Invariants enforced here:
 *  - a terminal state is immutable; later evidence is stored but cannot reopen the session;
 *  - state never moves backwards — out-of-order evidence updates evidence, not history;
 *  - client completion alone can never reach PENDING_VERIFICATION, VERIFIED or REWARDED;
 *  - VERIFIED and REWARDED require an explicit domain decision, never evidence alone.
 */
export function deriveSessionState(input: DeriveSessionStateInput): DeriveSessionStateResult {
  const previousState = input.currentState;
  const reasonCodes: SessionDerivationReason[] = [];

  if (isTerminalAdSessionState(previousState)) {
    return {
      state: previousState,
      previousState,
      changed: false,
      terminal: true,
      evidenceOnly: true,
      reasonCodes: ['TERMINAL_STATE_IMMUTABLE'],
    };
  }

  const candidate = deriveCandidateState(input, reasonCodes);

  if (candidate !== previousState && isTerminalAdSessionState(candidate)) {
    return {
      state: candidate,
      previousState,
      changed: true,
      terminal: true,
      evidenceOnly: false,
      reasonCodes: [...reasonCodes, 'DERIVED_FROM_EVIDENCE'],
    };
  }

  if (AD_SESSION_STATE_RANK[candidate] <= AD_SESSION_STATE_RANK[previousState]) {
    return {
      state: previousState,
      previousState,
      changed: false,
      terminal: false,
      evidenceOnly: true,
      reasonCodes: [
        ...reasonCodes,
        candidate === previousState
          ? 'EVIDENCE_ONLY_NO_FORWARD_TRANSITION'
          : 'OUT_OF_ORDER_EVIDENCE_RECORDED',
      ],
    };
  }

  return {
    state: candidate,
    previousState,
    changed: true,
    terminal: false,
    evidenceOnly: false,
    reasonCodes: [...reasonCodes, 'DERIVED_FROM_EVIDENCE'],
  };
}

function deriveCandidateState(
  input: DeriveSessionStateInput,
  reasonCodes: SessionDerivationReason[],
): AdSessionState {
  const { signals } = input;

  // Explicit terminal evidence wins over progress evidence.
  if (hasSignal(signals, 'POLICY_REJECTION')) return 'REJECTED';
  if (hasSignal(signals, 'NO_FILL')) return 'NO_FILL';
  if (
    hasSignal(signals, 'TECHNICAL_FAILURE') ||
    hasSignal(signals, 'LOAD_FAILURE') ||
    hasSignal(signals, 'START_FAILURE')
  ) {
    return 'FAILED';
  }
  if (hasSignal(signals, 'USER_SKIPPED')) return 'SKIPPED';

  if (input.rewardCommitted) return 'REWARDED';

  const clientCompleted = hasClientCompletion(signals);
  const providerCorrelated = hasCorrelatedProviderConfirmation(signals);
  const providerPresent = hasProviderConfirmationEvidence(signals);

  if (input.verificationPassed && clientCompleted && providerCorrelated) return 'VERIFIED';

  if (clientCompleted && providerCorrelated) return 'PENDING_VERIFICATION';

  if (clientCompleted && providerPresent && !providerCorrelated) {
    reasonCodes.push('PROVIDER_EVIDENCE_NOT_CORRELATED');
    return 'CLIENT_COMPLETION_RECEIVED';
  }

  if (providerPresent && !clientCompleted) return 'PROVIDER_CONFIRMATION_RECEIVED';

  if (clientCompleted) {
    reasonCodes.push('CLIENT_EVIDENCE_ALONE_INSUFFICIENT');
    return maybeExpire(input, 'CLIENT_COMPLETION_RECEIVED', reasonCodes);
  }

  if (hasSignal(signals, 'AD_STARTED')) return maybeExpire(input, 'STARTED', reasonCodes);
  if (hasSignal(signals, 'AD_LOADED')) return maybeExpire(input, 'LOADED', reasonCodes);
  if (hasSignal(signals, 'REQUEST_APPROVED')) return maybeExpire(input, 'REQUESTED', reasonCodes);
  if (input.authorizationPassed) return maybeExpire(input, 'AUTHORIZED', reasonCodes);
  if (input.quoteCommitted) return maybeExpire(input, 'QUOTED', reasonCodes);
  return maybeExpire(input, 'CREATED', reasonCodes);
}

/**
 * Sessions that never produced completion evidence expire once the window closes.
 * Sessions holding completion/verification evidence are left to the verification path so
 * an expiry sweep can never erase an earlier fact.
 */
function maybeExpire(
  input: DeriveSessionStateInput,
  candidate: AdSessionState,
  reasonCodes: SessionDerivationReason[],
): AdSessionState {
  if (candidate === 'CLIENT_COMPLETION_RECEIVED') return candidate;
  if (input.asOf.getTime() <= input.expiresAt.getTime()) return candidate;
  reasonCodes.push('EVIDENCE_WINDOW_EXPIRED');
  return 'EXPIRED';
}
