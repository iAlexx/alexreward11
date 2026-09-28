/**
 * Presentation-only greeting period from local clock.
 * Not financial truth; never invents a display name.
 */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

export function resolveGreetingPeriod(now: Date = new Date()): GreetingPeriod {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

export function resolveGreetingName(
  firstName: string | null | undefined,
  fallback: string,
): string {
  const trimmed = firstName?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  return fallback;
}
