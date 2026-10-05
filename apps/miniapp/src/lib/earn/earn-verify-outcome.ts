import type { AttemptVerifyResponse } from '../api/client';

/** Narrowed verification result that alone may trigger Reward Drop celebration. */
export type IssuedVerifyResult = AttemptVerifyResponse & { readonly issued: true };

export type EarnVerifyUiKind =
  | 'issued'
  | 'already_rewarded'
  | 'not_verified'
  | 'monetary_blocked';

export interface EarnVerifyUiOutcome {
  readonly kind: EarnVerifyUiKind;
  readonly result: AttemptVerifyResponse;
  readonly issuedCelebration: IssuedVerifyResult | null;
}

/**
 * Map attempt-verify server response to UI outcome.
 * Reward Drop celebration requires issued === true exclusively.
 */
export function resolveEarnVerifyOutcome(result: AttemptVerifyResponse): EarnVerifyUiOutcome {
  if (result.issued === true) {
    const issued: IssuedVerifyResult = { ...result, issued: true };
    return { kind: 'issued', result, issuedCelebration: issued };
  }
  if (result.alreadyRewarded === true) {
    return { kind: 'already_rewarded', result, issuedCelebration: null };
  }
  if (result.monetary !== null && result.monetary.eligible === false) {
    return { kind: 'monetary_blocked', result, issuedCelebration: null };
  }
  return { kind: 'not_verified', result, issuedCelebration: null };
}

/** CLIENT_COMPLETION alone never produces celebration. */
export function clientCompletionMayCelebrate(): false {
  return false;
}
