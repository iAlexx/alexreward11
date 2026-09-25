const BEARER_STORAGE_KEY = 'alex.admin.bearer';

/** In-memory + sessionStorage bearer for automation; cookie is primary for browser. */
let memoryToken: string | null = null;

export function getStoredBearerToken(): string | null {
  if (memoryToken !== null) return memoryToken;
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(BEARER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredBearerToken(token: string | null): void {
  memoryToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token === null || token.trim() === '') {
      sessionStorage.removeItem(BEARER_STORAGE_KEY);
    } else {
      sessionStorage.setItem(BEARER_STORAGE_KEY, token);
    }
  } catch {
    // sessionStorage may be unavailable; memory still holds the token.
  }
}

export function clearStoredBearerToken(): void {
  setStoredBearerToken(null);
}
