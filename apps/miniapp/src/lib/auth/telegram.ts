/**
 * Telegram WebApp initData access.
 *
 * Never treat Telegram's client-side user object as authenticated identity. Only the raw
 * signed `initData` string is sent to `POST /v1/auth/telegram` for server HMAC verification.
 */

export function readTelegramInitData(): string | null {
  if (typeof window === 'undefined') return null;
  const initData = window.Telegram?.WebApp?.initData;
  if (typeof initData !== 'string') return null;
  const trimmed = initData.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Dev-only initData for local browser testing outside Telegram.
 *
 * Impossible in production builds: `NODE_ENV === 'production'` and
 * `NEXT_PUBLIC_ALLOW_DEV_INIT_DATA` must both allow it, and a non-empty
 * `NEXT_PUBLIC_DEV_INIT_DATA` must be present. Never trust Telegram's unsafe user object.
 */
export function readDevInitData(): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.NEXT_PUBLIC_ALLOW_DEV_INIT_DATA !== '1') return null;
  const raw = process.env.NEXT_PUBLIC_DEV_INIT_DATA?.trim() ?? '';
  return raw.length > 0 ? raw : null;
}

/** Prefer genuine Telegram initData; fall back to the gated dev string only. */
export function resolveAuthInitData(): string | null {
  return readTelegramInitData() ?? readDevInitData();
}
