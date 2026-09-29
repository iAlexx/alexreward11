/**
 * Public Referral /start transport bridge (Bot).
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
  | { readonly kind: 'IGNORE' };

/**
 * Resolve a Telegram /start payload into a Mini App launch URL when safe.
 * Malformed / unsafe / unrelated payloads => IGNORE (no referral state).
 */
export function resolveReferralStartBridge(input: {
  readonly startPayload: string | null | undefined;
  readonly botUsername: string | undefined;
}): ReferralStartBridgeResult {
  const username = input.botUsername;
  if (username === undefined || username === '') {
    return { kind: 'IGNORE' };
  }
  const raw = input.startPayload ?? '';
  if (raw === '') {
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
