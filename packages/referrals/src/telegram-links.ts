/**
 * Telegram referral deep-link / start-parameter transport helpers.
 *
 * Telegram start parameters allow A-Z a-z 0-9 _ - only, max 64 chars total.
 * Referral transport is `ref_<code>` so generated codes are max 60 chars and
 * must use that alphabet. URL-encoding is NOT an escape hatch for unsafe codes.
 *
 * No production alphabet/length defaults. No attribution / financial authority.
 */
import { REFERRAL_START_PREFIX } from './start-param.js';

/** Telegram Bot API start-parameter maximum length. */
export const TELEGRAM_START_MAX_LENGTH = 64 as const;

/** Maximum referral code length given `ref_` prefix (4) + Telegram 64 cap. */
export const REFERRAL_CODE_MAX_TELEGRAM_LENGTH = 60 as const;

/** Minimum supported generated referral code length (unchanged). */
export const REFERRAL_CODE_MIN_LENGTH = 8 as const;

const TELEGRAM_SAFE_CODE_CHAR = /^[A-Za-z0-9_-]$/;

export type ReferralStartPayloadResult =
  | { readonly ok: true; readonly payload: `${typeof REFERRAL_START_PREFIX}${string}` }
  | {
      readonly ok: false;
      readonly reason: 'EMPTY' | 'UNSAFE_ALPHABET' | 'OVERLENGTH';
    };

/** True when every symbol is Telegram start-param safe (A-Za-z0-9_-). */
export function isTelegramSafeReferralCodeAlphabetChar(ch: string): boolean {
  return TELEGRAM_SAFE_CODE_CHAR.test(ch);
}

/**
 * Build `ref_<exact-code>` only when the opaque code is Telegram-transport-safe.
 * No case normalization, trimming, or rewrite of code identity.
 */
export function buildReferralStartPayload(code: string): ReferralStartPayloadResult {
  if (code === '') {
    return { ok: false, reason: 'EMPTY' };
  }
  const symbols = Array.from(code);
  for (const ch of symbols) {
    if (!isTelegramSafeReferralCodeAlphabetChar(ch)) {
      return { ok: false, reason: 'UNSAFE_ALPHABET' };
    }
  }
  const payload = `${REFERRAL_START_PREFIX}${code}` as const;
  if (payload.length > TELEGRAM_START_MAX_LENGTH) {
    return { ok: false, reason: 'OVERLENGTH' };
  }
  return { ok: true, payload };
}

/**
 * Spec public share link: https://t.me/<username>?start=ref_<code>
 * Returns null when username/code cannot form a Telegram-safe start parameter.
 */
export function buildReferralBotStartLink(
  username: string,
  code: string,
): string | null {
  if (username === '') return null;
  const built = buildReferralStartPayload(code);
  if (!built.ok) return null;
  return `https://t.me/${username}?start=${built.payload}`;
}

/**
 * Mini App launch bridge: https://t.me/<username>?startapp=ref_<code>
 * Bot transport only — does not attribute referrals.
 */
export function buildReferralMiniAppLaunchLink(
  username: string,
  code: string,
): string | null {
  if (username === '') return null;
  const built = buildReferralStartPayload(code);
  if (!built.ok) return null;
  return `https://t.me/${username}?startapp=${built.payload}`;
}


/** Canonical Telegram bot username (no leading @), matches config validation. */
const TELEGRAM_PUBLIC_BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

/**
 * Main Mini App launch link with no startapp payload:
 * https://t.me/<username>?startapp
 * Presentation/transport only — no referral identity.
 */
export function buildMainMiniAppLaunchLink(username: string): string | null {
  if (!TELEGRAM_PUBLIC_BOT_USERNAME.test(username)) {
    return null;
  }
  return `https://t.me/${username}?startapp`;
}
