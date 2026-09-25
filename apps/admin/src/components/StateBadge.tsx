'use client';

export function StateBadge({
  state,
  tone = 'neutral',
}: {
  readonly state: string;
  readonly tone?: 'neutral' | 'success' | 'warning' | 'error' | 'info';
}) {
  return (
    <span className={`admin-badge admin-badge--${tone}`} data-state={state}>
      {state}
    </span>
  );
}

export function toneForState(state: string): 'neutral' | 'success' | 'warning' | 'error' | 'info' {
  const upper = state.toUpperCase();
  if (
    upper.includes('BLOCKED') ||
    upper.includes('CRITICAL') ||
    upper.includes('FAILED') ||
    upper.includes('ERROR') ||
    upper.includes('PAUSED')
  ) {
    return 'error';
  }
  if (
    upper.includes('WARN') ||
    upper.includes('PENDING') ||
    upper.includes('HOLD') ||
    upper.includes('ESTIMATED') ||
    upper.includes('DEGRADED')
  ) {
    return 'warning';
  }
  if (
    upper.includes('READY') ||
    upper.includes('ACTIVE') ||
    upper.includes('CONFIRMED') ||
    upper.includes('SETTLED') ||
    upper.includes('APPROVED')
  ) {
    return 'success';
  }
  if (upper.includes('INFO') || upper.includes('SYNC')) return 'info';
  return 'neutral';
}
