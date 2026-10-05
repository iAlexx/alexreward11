/**
 * Client integration boundary for AdsGram.
 *
 * The official `@adsgram/react` package (version 1.0.2) is integrated **only** at
 * `apps/miniapp`, where React lives. `packages/ads` deliberately declares no dependency on
 * it and imports nothing from React: this package is a server-side domain module, and a
 * provider SDK reaching into the reward pipeline would blur the line between client
 * evidence and financial authority.
 *
 * What crosses this boundary is data, not code:
 *
 *   apps/miniapp  --(ClientCompletionSignalPayload over the authenticated API)-->  packages/ads
 *
 * The mini app renders the AdsGram unit, observes the SDK callbacks and posts a normalized
 * payload to the server. `packages/ads` then stores it as UNVERIFIED client evidence.
 *
 * Spec V1.3 §20: an AdsGram client success is a *signal*, never direct financial
 * authority. A client completion alone must never reach VERIFIED, REWARDED or any
 * ledger-posting command. Nothing in this file can credit money, and no field here is
 * trusted for amounts, entitlements or limits.
 */

/** Client-observed lifecycle events the mini app may report for a rewarded session. */
export type ClientCompletionSignalEvent =
  | 'REQUEST_APPROVED'
  | 'AD_LOADED'
  | 'AD_STARTED'
  | 'CLIENT_COMPLETION'
  | 'NO_FILL'
  | 'LOAD_FAILURE'
  | 'START_FAILURE'
  | 'TECHNICAL_FAILURE'
  | 'USER_SKIPPED';

/**
 * The only shape the mini app sends to the server for a rewarded ad session.
 *
 * Intentionally carries no amount, no asset, no user identity and no provider secret:
 * the session id is the correlation handle, the authenticated caller is the identity, and
 * the Reward Engine owns every monetary value.
 */
export interface ClientCompletionSignalPayload {
  /** Server-issued ad session id returned by session authorization. */
  readonly adSessionId: string;
  readonly event: ClientCompletionSignalEvent;
  /** Client clock, stored as evidence only; server time remains authoritative. */
  readonly occurredAtIso?: string;
  /** Optional provider block/placement echo, for forensics only. */
  readonly placementCode?: string;
  /** Optional client-side error/close reason code, for forensics only. */
  readonly clientReasonCode?: string;
}

/** Documented integration point of the official provider SDK. */
export const ADSGRAM_CLIENT_SDK_PACKAGE = '@adsgram/react';
export const ADSGRAM_CLIENT_SDK_VERSION = '1.0.2';
export const ADSGRAM_CLIENT_SDK_INTEGRATION_PATH = 'apps/miniapp';
