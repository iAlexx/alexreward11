'use client';

import { isLocaleCode, type LocaleCode } from '@alex-rewards/contracts';
import { defaultLocale, isLocale, isRtlLocale } from '@alex-rewards/i18n';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';

import { ApiError, createApiClient, type ApiClient } from '../lib/api/client';
import {
  clearStoredAuth,
  loadStoredAuth,
  saveStoredAuth,
  type AuthSession,
  type AuthUser,
  type StoredAuth,
} from '../lib/auth/session-store';
import { resolveAuthInitData } from '../lib/auth/telegram';
import { AuthSplash } from '../components/AuthSplash';
import { webConfig } from '../lib/env';
import { useLocaleMessages } from './LocaleMessagesProvider';

export type AuthStatus =
  | 'LOADING'
  | 'READY'
  | 'UNAUTHORIZED'
  | 'EXPIRED'
  | 'UNAVAILABLE';

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: AuthUser | null;
  readonly accessToken: string | null;
  readonly api: ApiClient;
  readonly locale: LocaleCode;
  readonly retry: () => void;
  readonly signOut: () => Promise<void>;
  readonly setPreferredLocale: (locale: LocaleCode) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function applyDocumentLocale(locale: LocaleCode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
}

function toLocale(value: string | null | undefined): LocaleCode {
  return isLocaleCode(value) ? value : defaultLocale;
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const localeMessages = useLocaleMessages();
  const t = useTranslations('auth');

  const [status, setStatus] = useState<AuthStatus>('LOADING');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [locale, setLocale] = useState<LocaleCode>(toLocale(localeMessages.locale));
  const [bootNonce, setBootNonce] = useState(0);

  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;

  const persist = useCallback(
    (next: StoredAuth) => {
      saveStoredAuth(next);
      setUser(next.user);
      setSession(next.session);
      const nextLocale = toLocale(next.user.preferredLocale);
      setLocale(nextLocale);
      applyDocumentLocale(nextLocale);
      if (isLocale(nextLocale)) {
        localeMessages.setLocale(nextLocale);
      }
    },
    [localeMessages],
  );

  const clear = useCallback(() => {
    clearStoredAuth();
    setUser(null);
    setSession(null);
    void queryClient.clear();
  }, [queryClient]);

  const refreshSession = useCallback(async (): Promise<string | null> => {
    const current = sessionRef.current ?? loadStoredAuth()?.session ?? null;
    if (current === null) return null;
    try {
      const refreshed = await createApiClient({
        baseUrl: webConfig.NEXT_PUBLIC_API_BASE_URL,
        getAccessToken: () => null,
      }).refresh(current.refreshToken);
      const stored = loadStoredAuth();
      const nextUser = stored?.user ?? user;
      if (nextUser === null) {
        clear();
        setStatus('EXPIRED');
        return null;
      }
      const nextSession: AuthSession = {
        accessToken: refreshed.accessToken,
        accessExpiresAt: refreshed.accessExpiresAt,
        refreshToken: refreshed.refreshToken,
        refreshExpiresAt: refreshed.refreshExpiresAt,
        sessionId: refreshed.sessionId,
      };
      persist({ user: nextUser, session: nextSession });
      return refreshed.accessToken;
    } catch (error) {
      clear();
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setStatus('EXPIRED');
      } else {
        setStatus('UNAVAILABLE');
      }
      return null;
    }
  }, [clear, persist, user]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: webConfig.NEXT_PUBLIC_API_BASE_URL,
        getAccessToken: () => sessionRef.current?.accessToken ?? null,
        refreshSession,
        onUnauthorized: () => {
          clear();
          setStatus('EXPIRED');
        },
      }),
    [clear, refreshSession],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      setStatus('LOADING');
      const existing = loadStoredAuth();
      if (existing !== null) {
        persist(existing);
        const expiresAt = Date.parse(existing.session.accessExpiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 30_000) {
          const token = await refreshSession();
          if (cancelled) return;
          if (token === null) return;
        }
        if (!cancelled) setStatus('READY');
        return;
      }

      const initData = resolveAuthInitData();
      if (initData === null) {
        if (!cancelled) {
          clear();
          setStatus('UNAUTHORIZED');
        }
        return;
      }

      try {
        const result = await createApiClient({
          baseUrl: webConfig.NEXT_PUBLIC_API_BASE_URL,
          getAccessToken: () => null,
        }).authTelegram(initData);
        if (cancelled) return;
        persist(result);
        setStatus('READY');
      } catch (error) {
        if (cancelled) return;
        clear();
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setStatus('UNAUTHORIZED');
        } else {
          setStatus('UNAVAILABLE');
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [bootNonce, clear, persist, refreshSession]);

  const retry = useCallback(() => {
    setBootNonce((value) => value + 1);
  }, []);

  const signOut = useCallback(async () => {
    try {
      if (sessionRef.current !== null) {
        await api.logout();
      }
    } catch {
      // Local sign-out still proceeds; server revoke is best-effort.
    }
    clear();
    setStatus('UNAUTHORIZED');
  }, [api, clear]);

  const setPreferredLocale = useCallback(
    (next: LocaleCode) => {
      setLocale(next);
      applyDocumentLocale(next);
      if (isLocale(next)) {
        localeMessages.setLocale(next);
      }
      setUser((current) => {
        if (current === null) return current;
        const updated = { ...current, preferredLocale: next };
        const currentSession = sessionRef.current;
        if (currentSession !== null) {
          saveStoredAuth({ user: updated, session: currentSession });
        }
        return updated;
      });
    },
    [localeMessages],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      accessToken: session?.accessToken ?? null,
      api,
      locale,
      retry,
      signOut,
      setPreferredLocale,
    }),
    [api, locale, retry, session?.accessToken, setPreferredLocale, signOut, status, user],
  );

  if (status === 'LOADING') {
    return <AuthSplash />;
  }

  if (status !== 'READY') {
    const titleKey =
      status === 'UNAUTHORIZED'
        ? 'unauthorizedTitle'
        : status === 'EXPIRED'
          ? 'expiredTitle'
          : 'unavailableTitle';
    const bodyKey =
      status === 'UNAUTHORIZED' ? 'unauthorized' : status === 'EXPIRED' ? 'expired' : 'unavailable';
    return (
      <div className="alex-screen alex-screen--center lootra-auth-error" role="alert">
        <h1 className="alex-title">{t(titleKey)}</h1>
        <p className="alex-muted">{t(bodyKey)}</p>
        <button type="button" className="alex-button lootra-btn lootra-btn--primary" onClick={retry}>
          {t('retry')}
        </button>
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
