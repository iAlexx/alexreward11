/** Presentational helpers for Profile / Support — no financial authority. */

const KNOWN_ACCOUNT_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'BLOCKED', 'PENDING']);
const KNOWN_WITHDRAWAL_STATUSES = new Set([
  'ALLOWED',
  'BLOCKED',
  'PAUSED',
  'COOLDOWN',
  'RESTRICTED',
]);

export function localizeAccountStatus(
  status: string,
  t: (key: string) => string,
  unknownKey: string,
): string {
  if (KNOWN_ACCOUNT_STATUSES.has(status)) {
    return t(`accountStatus_${status}`);
  }
  return t(unknownKey).replace('{status}', status);
}

export function localizeWithdrawalStatus(
  status: string,
  t: (key: string) => string,
  unknownKey: string,
): string {
  if (KNOWN_WITHDRAWAL_STATUSES.has(status)) {
    return t(`withdrawalStatus_${status}`);
  }
  return t(unknownKey).replace('{status}', status);
}

/** Human-readable ISO timestamp presentation only. */
export function formatServerTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  try {
    return new Date(parsed).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function canReplyToSupportTicket(state: string): boolean {
  return state !== 'CLOSED' && state !== 'RESOLVED';
}

export function profileInitials(input: {
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}): string {
  const user = input.username?.trim();
  if (user !== undefined && user !== '') return user.slice(0, 1).toUpperCase();
  const first = input.firstName?.trim();
  if (first !== undefined && first !== '') return first.slice(0, 1).toUpperCase();
  const last = input.lastName?.trim();
  if (last !== undefined && last !== '') return last.slice(0, 1).toUpperCase();
  return 'L';
}

export function profileDisplayName(input: {
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}): string {
  const user = input.username?.trim();
  if (user !== undefined && user !== '') return `@${user}`;
  const parts = [input.firstName?.trim(), input.lastName?.trim()].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  if (parts.length > 0) return parts.join(' ');
  return '';
}
