import type { AdSessionState, ProviderLimitMetric, ProviderLimitWindow } from './types.js';

/**
 * AdsGram provider identity. These values mirror migration
 * `0030_phase11_adsgram_foundation.sql` — the database row is authoritative and
 * these constants exist only so the compile-time adapter registry can bind to it.
 */
export const ADSGRAM_PROVIDER_ID = 'a11a11a1-0000-4000-8000-00000000ad51';
export const ADSGRAM_CODE = 'ADSGRAM';

/** Reward URL path that AdsGram is configured to call (see ad_units.server_config). */
export const ADSGRAM_REWARD_URL_PATH = '/webhooks/adsgram/reward';

/** Clarification register consulted by the monetary gate before production money. */
export const ADSGRAM_CLARIFICATION_REFERENCE = 'docs/ADSGRAM_CLARIFICATION_REGISTER.md';

/**
 * Default session evidence window. Sessions past this window derive EXPIRED and
 * can never be rewarded. Provider delivery windows are not documented, so this
 * value is a platform safety bound, not a provider guarantee.
 */
export const DEFAULT_AD_SESSION_TTL_SECONDS = 900;

/**
 * Best-effort correlation window for an unsigned provider server signal.
 * Correlation alone never authorizes money (Spec V1.3 §20).
 */
export const PROVIDER_SIGNAL_CORRELATION_WINDOW_SECONDS = 3600;

export const TERMINAL_AD_SESSION_STATES: ReadonlySet<AdSessionState> = new Set([
  'REWARDED',
  'NO_FILL',
  'FAILED',
  'SKIPPED',
  'REJECTED',
  'EXPIRED',
]);

/** Non-terminal states covered by the one-live-session-per-user-per-provider index. */
export const LIVE_AD_SESSION_STATES: readonly AdSessionState[] = [
  'CREATED',
  'QUOTED',
  'AUTHORIZED',
  'REQUESTED',
  'LOADED',
  'STARTED',
  'CLIENT_COMPLETION_RECEIVED',
  'PROVIDER_CONFIRMATION_RECEIVED',
  'PENDING_VERIFICATION',
  'VERIFIED',
];

/**
 * Forward-only ordering used to reject out-of-order state regressions.
 * Terminal states share the highest rank band; the terminal check runs first.
 */
export const AD_SESSION_STATE_RANK: Readonly<Record<AdSessionState, number>> = {
  CREATED: 0,
  QUOTED: 1,
  AUTHORIZED: 2,
  REQUESTED: 3,
  LOADED: 4,
  STARTED: 5,
  CLIENT_COMPLETION_RECEIVED: 6,
  PROVIDER_CONFIRMATION_RECEIVED: 6,
  PENDING_VERIFICATION: 7,
  VERIFIED: 8,
  REWARDED: 9,
  NO_FILL: 9,
  FAILED: 9,
  SKIPPED: 9,
  REJECTED: 9,
  EXPIRED: 9,
};

/** Dimensions the session authorizer must have an ACTIVE rule for. */
export const REQUIRED_LIMIT_DIMENSIONS: readonly {
  readonly metric: ProviderLimitMetric;
  readonly window: ProviderLimitWindow;
}[] = [
  { metric: 'REQUEST', window: 'UTC_DAY' },
  { metric: 'SUCCESS', window: 'UTC_DAY' },
];

/**
 * Limit scopes that represent an absolute provider/contract ceiling.
 * Platform/user/country scopes may be stricter but never looser (Spec V1.3 §2.1).
 */
export const HARD_LIMIT_SCOPES: readonly string[] = ['PROVIDER_HARD', 'CONTRACT'];

/** Idempotency scope used for AD reward issuance keys. */
export const AD_REWARD_IDEMPOTENCY_PREFIX = 'ads.reward';
