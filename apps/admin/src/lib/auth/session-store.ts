/**
 * Browser Admin session store is cookie-only (P13-02).
 * sessionStorage / localStorage / memory bearer tokens are neutralized.
 * Bearer Authorization remains allowed only for non-browser test/CLI clients.
 */

const LEGACY_BEARER_STORAGE_KEY = 'alex.admin.bearer';

/** Always null in browser — cookie carries the session. */
export function getStoredBearerToken(): string | null {
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(LEGACY_BEARER_STORAGE_KEY);
      localStorage.removeItem(LEGACY_BEARER_STORAGE_KEY);
    } catch {
      // ignore storage access failures
    }
  }
  return null;
}

/** No-op in browser — never persist opaque session tokens client-side. */
export function setStoredBearerToken(_token: string | null): void {
  void _token;
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(LEGACY_BEARER_STORAGE_KEY);
      localStorage.removeItem(LEGACY_BEARER_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export function clearStoredBearerToken(): void {
  setStoredBearerToken(null);
}
