/** Non-sensitive presentation preference only. Never store auth or financial data. */
export const ONBOARDING_STORAGE_KEY = 'lootra:onboarding:v1';

const COMPLETED_VALUE = 'completed';

function storage(): Storage | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function hasCompletedOnboarding(): boolean {
  const store = storage();
  if (store === null) {
    // Storage unavailable — allow app use without blocking.
    return true;
  }
  try {
    return store.getItem(ONBOARDING_STORAGE_KEY) === COMPLETED_VALUE;
  } catch {
    return true;
  }
}

export function markOnboardingComplete(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(ONBOARDING_STORAGE_KEY, COMPLETED_VALUE);
  } catch {
    // Fail open: preference is presentation-only.
  }
}
