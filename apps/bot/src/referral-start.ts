/**
 * Public /start transport bridge (Bot).
 *
 * Transport ONLY: never attributes referrals, never mutates referral_edges,
 * never issues rewards. Signed Mini App initData remains attribution authority.
 */
import {
  buildReferralMiniAppLaunchLink,
  buildReferralStartPayload,
  parseReferralStartParam,
} from '@alex-rewards/referrals';

export type ReferralStartBridgeResult =
  | {
      readonly kind: 'LAUNCH';
      readonly launchUrl: string;
      readonly payload: string;
      readonly code: string;
    }
  | {
      readonly kind: 'LAUNCH_MAIN';
      readonly webAppUrl: string;
    }
  | { readonly kind: 'IGNORE' };

/** Native Telegram Mini App inline button for plain /start (not a t.me URL button). */
export type PlainStartWebAppButton = {
  readonly text: 'Open LOOTRA';
  readonly web_app: { readonly url: string };
  readonly style: 'primary';
};

/**
 * True when the configured Mini App public URL is safe for web_app.url.
 * Rejects t.me deep links and non-http(s) schemes (fail closed).
 */
export function isSafeMiniAppPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 't.me' || host.endsWith('.t.me')) {
      return false;
    }
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Build the native primary Mini App button for plain /start. */
export function buildPlainStartWebAppButton(webAppUrl: string): PlainStartWebAppButton {
  return {
    text: 'Open LOOTRA',
    web_app: { url: webAppUrl },
    style: 'primary',
  };
}

/**
 * Resolve a Telegram /start payload into a launch action when safe.
 * - Empty payload => native Mini App web_app button (MINIAPP_PUBLIC_URL).
 * - Valid ref_<code> => referral Mini App launch (?startapp=ref_<code>).
 * - Malformed / unsafe / unrelated payloads => IGNORE (no referral state).
 */
export function resolveReferralStartBridge(input: {
  readonly startPayload: string | null | undefined;
  readonly botUsername: string | undefined;
  readonly miniAppPublicUrl: string | undefined;
}): ReferralStartBridgeResult {
  const raw = input.startPayload ?? '';
  if (raw === '') {
    const webAppUrl = input.miniAppPublicUrl;
    if (webAppUrl === undefined || webAppUrl === '' || !isSafeMiniAppPublicUrl(webAppUrl)) {
      return { kind: 'IGNORE' };
    }
    return { kind: 'LAUNCH_MAIN', webAppUrl };
  }
  const username = input.botUsername;
  if (username === undefined || username === '') {
    return { kind: 'IGNORE' };
  }
  const parsed = parseReferralStartParam(raw);
  if (parsed.kind !== 'REFERRAL_CODE') {
    return { kind: 'IGNORE' };
  }
  const payload = buildReferralStartPayload(parsed.code);
  if (!payload.ok) {
    return { kind: 'IGNORE' };
  }
  const launchUrl = buildReferralMiniAppLaunchLink(username, parsed.code);
  if (launchUrl === null) {
    return { kind: 'IGNORE' };
  }
  return {
    kind: 'LAUNCH',
    launchUrl,
    payload: payload.payload,
    code: parsed.code,
  };
}
