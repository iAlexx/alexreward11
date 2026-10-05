/**
 * Ad session state → user-facing label mapping, expressed purely in the type system.
 *
 * Deliberately types only: the API owns the runtime projection, so this module can never
 * become a second, drifting source of ad-session truth in a client bundle. `REWARDED` here
 * is a lifecycle label, not a statement that money was credited — only the balance read
 * model can say that.
 */

export type AdSessionStateDto =
  | 'CREATED'
  | 'QUOTED'
  | 'AUTHORIZED'
  | 'REQUESTED'
  | 'LOADED'
  | 'STARTED'
  | 'CLIENT_COMPLETION_RECEIVED'
  | 'PROVIDER_CONFIRMATION_RECEIVED'
  | 'PENDING_VERIFICATION'
  | 'VERIFIED'
  | 'REWARDED'
  | 'NO_FILL'
  | 'FAILED'
  | 'SKIPPED'
  | 'REJECTED'
  | 'EXPIRED';

export type AdSessionStateUserLabel =
  | 'PREPARING'
  | 'READY_TO_WATCH'
  | 'WATCHING'
  | 'VERIFYING'
  | 'REWARDED'
  | 'UNAVAILABLE'
  | 'INCOMPLETE'
  | 'EXPIRED';

/** Complete, exhaustive mapping — adding a state without a label is a compile error. */
export type AdSessionStateUserLabelMap = {
  readonly CREATED: 'PREPARING';
  readonly QUOTED: 'PREPARING';
  readonly AUTHORIZED: 'READY_TO_WATCH';
  readonly REQUESTED: 'READY_TO_WATCH';
  readonly LOADED: 'READY_TO_WATCH';
  readonly STARTED: 'WATCHING';
  readonly CLIENT_COMPLETION_RECEIVED: 'VERIFYING';
  readonly PROVIDER_CONFIRMATION_RECEIVED: 'VERIFYING';
  readonly PENDING_VERIFICATION: 'VERIFYING';
  readonly VERIFIED: 'VERIFYING';
  readonly REWARDED: 'REWARDED';
  readonly NO_FILL: 'UNAVAILABLE';
  readonly FAILED: 'INCOMPLETE';
  readonly SKIPPED: 'INCOMPLETE';
  readonly REJECTED: 'INCOMPLETE';
  readonly EXPIRED: 'EXPIRED';
} & { readonly [State in AdSessionStateDto]: AdSessionStateUserLabel };

export type UserLabelForAdSessionState<TState extends AdSessionStateDto> =
  AdSessionStateUserLabelMap[TState];
