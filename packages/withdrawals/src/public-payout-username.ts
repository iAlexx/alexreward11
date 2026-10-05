/**
 * Phase 17 — safe public Telegram username validation for payout publication snapshots.
 * Invalid usernames must become NULL (Anonymous User). No identity fallback.
 */
const TELEGRAM_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function sanitizePublicPayoutUsernameSnapshot(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let s = raw.trim();
  if (s.startsWith('@')) {
    s = s.slice(1).trim();
  }
  if (s === '' || !TELEGRAM_USERNAME_RE.test(s)) {
    return null;
  }
  return s;
}
