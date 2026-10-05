export type WithdrawalStateGroup = 'IN_PROGRESS' | 'ATTENTION' | 'FINAL' | 'UNKNOWN';

const IN_PROGRESS = new Set([
  'REQUESTED',
  'RISK_CHECK',
  'MANUAL_REVIEW',
  'APPROVED',
  'QUEUED',
  'SIGNING',
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
]);

const ATTENTION = new Set(['HELD', 'FAILED_PRE_BROADCAST', 'RECONCILE_REQUIRED']);

const FINAL = new Set(['CONFIRMED', 'REJECTED']);

/** Presentational grouping only — never sent to the server. */
export function withdrawalStateGroup(state: string): WithdrawalStateGroup {
  if (IN_PROGRESS.has(state)) return 'IN_PROGRESS';
  if (ATTENTION.has(state)) return 'ATTENTION';
  if (FINAL.has(state)) return 'FINAL';
  return 'UNKNOWN';
}

export type HistoryFilter = 'all' | 'in_progress' | 'attention' | 'final';

export function matchesHistoryFilter(state: string, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  const group = withdrawalStateGroup(state);
  if (filter === 'in_progress') return group === 'IN_PROGRESS' || group === 'UNKNOWN';
  if (filter === 'attention') return group === 'ATTENTION';
  return group === 'FINAL';
}

/** i18n key fragment for a withdrawal state label. */
export function withdrawalStateMessageKey(state: string): string {
  return `state_${state}`;
}

const KNOWN_STATES = new Set([
  ...IN_PROGRESS,
  ...ATTENTION,
  ...FINAL,
]);

export function isKnownWithdrawalState(state: string): boolean {
  return KNOWN_STATES.has(state);
}
