/**
 * Safe task display helpers.
 * nameKey is server-provided — never pass arbitrary values into next-intl lookups.
 * Progress is presentational only and never mutates account/financial state.
 */

/** Allowlisted mission name keys that may resolve to localized titles. Empty until product adds them. */
export const ALLOWED_TASK_NAME_KEYS = new Set<string>([
  // Intentionally empty — no approved mission catalog keys yet.
]);

export function resolveTaskDisplayName(
  nameKey: string,
  fallback: string,
  translateAllowed?: (key: string) => string,
): string {
  if (ALLOWED_TASK_NAME_KEYS.has(nameKey) && translateAllowed !== undefined) {
    return translateAllowed(nameKey);
  }
  return fallback;
}

export function safeTaskProgress(
  progressCount: number,
  target: number,
): { readonly progress: number; readonly target: number; readonly ratio: number } {
  const progress =
    Number.isFinite(progressCount) && progressCount >= 0 ? Math.floor(progressCount) : 0;
  const safeTarget = Number.isFinite(target) && target > 0 ? Math.floor(target) : 0;
  const ratio = safeTarget > 0 ? Math.min(1, progress / safeTarget) : 0;
  return { progress, target: safeTarget, ratio };
}

export const TASK_STATE_LABEL_KEYS = {
  NOT_STARTED: 'state_NOT_STARTED',
  IN_PROGRESS: 'state_IN_PROGRESS',
  COMPLETED: 'state_COMPLETED',
  CLAIMED: 'state_CLAIMED',
  EXPIRED: 'state_EXPIRED',
} as const;

export type KnownTaskState = keyof typeof TASK_STATE_LABEL_KEYS;

export function isKnownTaskState(state: string): state is KnownTaskState {
  return state in TASK_STATE_LABEL_KEYS;
}
