import type { LocaleCode } from '@alex-rewards/contracts';

export interface AuthUser {
  readonly id: string;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly preferredLocale: LocaleCode;
  readonly status: string;
  readonly withdrawalStatus: string;
  readonly created: boolean;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly sessionId: string;
}

export interface StoredAuth {
  readonly user: AuthUser;
  readonly session: AuthSession;
}

const STORAGE_KEY = 'alex.rewards.auth.v1';

function canUseSessionStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

export function loadStoredAuth(): StoredAuth | null {
  if (!canUseSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null || raw.trim() === '') return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredAuth(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredAuth(auth: StoredAuth): void {
  if (!canUseSessionStorage()) return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearStoredAuth(): void {
  if (!canUseSessionStorage()) return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

function isStoredAuth(value: unknown): value is StoredAuth {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const user = record['user'];
  const session = record['session'];
  if (user === null || typeof user !== 'object') return false;
  if (session === null || typeof session !== 'object') return false;
  const u = user as Record<string, unknown>;
  const s = session as Record<string, unknown>;
  return (
    typeof u['id'] === 'string' &&
    typeof u['telegramUserId'] === 'string' &&
    typeof u['preferredLocale'] === 'string' &&
    typeof s['accessToken'] === 'string' &&
    typeof s['refreshToken'] === 'string' &&
    typeof s['sessionId'] === 'string' &&
    typeof s['accessExpiresAt'] === 'string' &&
    typeof s['refreshExpiresAt'] === 'string'
  );
}
