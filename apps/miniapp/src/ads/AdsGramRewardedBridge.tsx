'use client';

import type { AdsgramInitParams } from '@adsgram/common';
import { useAdsgram } from '@adsgram/react';
import { useCallback, useRef, useState } from 'react';

/**
 * Phase 11 client boundary for the official AdsGram SDK.
 *
 * This component is the *only* place `@adsgram/react` is allowed to live, and everything it
 * does is reporting. It observes the SDK callbacks and posts each observation to the
 * authenticated API as forensic evidence. It cannot credit anything:
 *
 *  - it never receives, computes or displays a reward amount;
 *  - `onReward` posts a `CLIENT_COMPLETION` signal, which the server stores as UNVERIFIED
 *    and which can never by itself reach VERIFIED or REWARDED (Spec V1.3 §20);
 *  - whether the attempt is rewardable is decided server-side by the provider-neutral
 *    monetary gate, which today refuses AdsGram production money.
 *
 * Phase 12 owns the Earn UI: the placement, copy, session lifecycle orchestration, balance
 * display and error surfaces all belong there. This file deliberately renders no chrome and
 * is exported without being mounted anywhere.
 */

/** Client-observed lifecycle events, mirroring `ClientCompletionSignalEvent` in packages/ads. */
export type AdsGramBridgeEvent =
  | 'REQUEST_APPROVED'
  | 'AD_LOADED'
  | 'AD_STARTED'
  | 'CLIENT_COMPLETION'
  | 'NO_FILL'
  | 'LOAD_FAILURE'
  | 'START_FAILURE'
  | 'TECHNICAL_FAILURE'
  | 'USER_SKIPPED';

export interface AdsGramRewardedBridgeProps {
  /** Server-issued ad session id from `POST /v1/ads/sessions/authorize`. */
  readonly adSessionId: string;
  /** Owner-configured AdsGram block id for the placement. Never a secret. */
  readonly blockId: AdsgramInitParams['blockId'];
  /** Bearer access token for the authenticated mini-app session. */
  readonly accessToken: string;
  /** API origin. Falls back to the public build-time value. */
  readonly apiBaseUrl?: string;
  /** Notified after each signal is reported, for Phase 12 UI state. Never a reward. */
  readonly onSignalReported?: (event: AdsGramBridgeEvent) => void;
  readonly children?: (bridge: AdsGramBridgeHandle) => React.ReactNode;
}

export interface AdsGramBridgeHandle {
  /** Request and play one rewarded ad, reporting every observed transition. */
  readonly showAd: () => Promise<void>;
  readonly busy: boolean;
  /** Last reported client event. Presentational only; carries no financial meaning. */
  readonly lastEvent: AdsGramBridgeEvent | null;
}

function resolveApiBaseUrl(explicit: string | undefined): string {
  const base = explicit ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  return base.replace(/\/+$/, '');
}

export function AdsGramRewardedBridge({
  adSessionId,
  blockId,
  accessToken,
  apiBaseUrl,
  onSignalReported,
  children,
}: AdsGramRewardedBridgeProps): React.ReactNode {
  const [busy, setBusy] = useState(false);
  const [lastEvent, setLastEvent] = useState<AdsGramBridgeEvent | null>(null);
  // Guards against a duplicate SDK callback producing a second POST for one attempt.
  const reported = useRef<Set<AdsGramBridgeEvent>>(new Set());

  const reportSignal = useCallback(
    async (event: AdsGramBridgeEvent, clientReasonCode?: string): Promise<void> => {
      if (reported.current.has(event)) return;
      reported.current.add(event);
      const base = resolveApiBaseUrl(apiBaseUrl);
      try {
        await fetch(`${base}/v1/ads/sessions/${adSessionId}/client-signal`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          // No amount, no asset, no identity: the session id correlates and the
          // authenticated caller is the identity.
          body: JSON.stringify({
            event,
            payload: {
              occurredAtIso: new Date().toISOString(),
              ...(clientReasonCode === undefined ? {} : { clientReasonCode }),
            },
          }),
        });
      } catch {
        // A lost evidence POST is not a financial event. The server-side session simply
        // expires; nothing is credited either way.
      }
      setLastEvent(event);
      onSignalReported?.(event);
    },
    [accessToken, adSessionId, apiBaseUrl, onSignalReported],
  );

  const handleReward = useCallback(() => {
    // Provider says the user watched the ad. That is a claim, not a payment.
    void reportSignal('CLIENT_COMPLETION');
  }, [reportSignal]);

  const handleError = useCallback(() => {
    void reportSignal('TECHNICAL_FAILURE', 'SDK_ON_ERROR');
  }, [reportSignal]);

  const { show } = useAdsgram({
    blockId,
    onReward: handleReward,
    onError: handleError,
  });

  const showAd = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    reported.current = new Set();
    await reportSignal('REQUEST_APPROVED');
    try {
      const result = await show();
      if (result.error) {
        await reportSignal(result.state === 'load' ? 'NO_FILL' : 'START_FAILURE', result.state);
      } else if (!result.done) {
        await reportSignal('USER_SKIPPED', result.state);
      }
    } catch {
      await reportSignal('TECHNICAL_FAILURE', 'SHOW_REJECTED');
    } finally {
      setBusy(false);
    }
  }, [busy, reportSignal, show]);

  if (children === undefined) return null;
  return <>{children({ showAd, busy, lastEvent })}</>;
}
