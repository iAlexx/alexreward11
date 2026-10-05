/**
 * Pure Mini App auth boot decision.
 *
 * Stored sessions may be reused only when an untrusted Telegram user-id hint
 * matches the previously server-authenticated telegramUserId. Mismatch or an
 * unparseable hint forces POST /v1/auth/telegram with the CURRENT raw initData.
 * This helper never authenticates, attributes referrals, or invents identity.
 */
import type { StoredAuth } from './session-store';
import { readTelegramUserIdHint } from './telegram-user-id-hint';

export type AuthBootDecision =
  | { readonly kind: 'REUSE_STORED'; readonly stored: StoredAuth }
  | {
      readonly kind: 'AUTHENTICATE_TELEGRAM';
      readonly initData: string;
      readonly clearStoredFirst: boolean;
    }
  | { readonly kind: 'UNAUTHORIZED' };

/**
 * Decide whether to reuse a stored session or force server Telegram auth.
 * Call with initData resolved BEFORE trusting stored auth.
 */
export function decideAuthBoot(input: {
  readonly stored: StoredAuth | null;
  readonly initData: string | null;
}): AuthBootDecision {
  const { stored, initData } = input;

  if (initData !== null && initData.trim() !== '') {
    if (stored !== null) {
      const hint = readTelegramUserIdHint(initData);
      if (hint !== null && hint === stored.user.telegramUserId) {
        return { kind: 'REUSE_STORED', stored };
      }
      // Hint mismatch OR unparseable user field -> fail safe, reauthenticate.
      return {
        kind: 'AUTHENTICATE_TELEGRAM',
        initData,
        clearStoredFirst: true,
      };
    }
    return {
      kind: 'AUTHENTICATE_TELEGRAM',
      initData,
      clearStoredFirst: false,
    };
  }

  // No Telegram initData: preserve existing non-Telegram/session behavior.
  if (stored !== null) {
    return { kind: 'REUSE_STORED', stored };
  }
  return { kind: 'UNAUTHORIZED' };
}