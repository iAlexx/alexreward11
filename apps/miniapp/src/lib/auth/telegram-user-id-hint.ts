/**
 * Untrusted Telegram initData context hints.
 *
 * NEVER treat parsed user fields as authenticated identity. Only the raw signed
 * initData string may be sent to POST /v1/auth/telegram for server HMAC verification.
 * Client-side user-id extraction is a reauthentication HINT only.
 */

const TELEGRAM_NUMERIC_ID = /^[1-9][0-9]{0,19}$/;

/**
 * Extract Telegram user id from raw initData as an UNTRUSTED context hint.
 * Returns a decimal string, or null when missing/malformed.
 * Must never authorize sessions, create users, or attribute referrals.
 */
export function readTelegramUserIdHint(rawInitData: string): string | null {
  if (typeof rawInitData !== 'string' || rawInitData.trim() === '') {
    return null;
  }
  try {
    const params = new URLSearchParams(rawInitData);
    const userRaw = params.get('user');
    if (userRaw === null || userRaw.trim() === '') {
      return null;
    }
    const parsed: unknown = JSON.parse(userRaw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const id = (parsed as Record<string, unknown>)['id'];
    let asString: string;
    if (typeof id === 'number') {
      if (!Number.isInteger(id) || id <= 0 || !Number.isSafeInteger(id)) {
        return null;
      }
      asString = String(id);
    } else if (typeof id === 'string') {
      asString = id.trim();
    } else {
      return null;
    }
    if (!TELEGRAM_NUMERIC_ID.test(asString)) {
      return null;
    }
    return asString;
  } catch {
    return null;
  }
}