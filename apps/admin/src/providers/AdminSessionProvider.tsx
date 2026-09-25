'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createAdminApiClient, type AdminApiClient } from '../lib/admin-api/client';
import type { AdminSessionResponse } from '../lib/admin-api/types';
import {
  clearStoredBearerToken,
  getStoredBearerToken,
  setStoredBearerToken,
} from '../lib/auth/session-store';
import { webConfig } from '../lib/env';

type SessionStatus = 'LOADING' | 'AUTHENTICATED' | 'UNAUTHENTICATED';

type AdminSessionContextValue = {
  readonly status: SessionStatus;
  readonly session: AdminSessionResponse | null;
  readonly api: AdminApiClient;
  readonly setSessionFromLogin: (sessionToken: string) => Promise<void>;
  readonly refreshSession: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly markUnauthenticated: () => void;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function AdminSessionProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('LOADING');
  const [session, setSession] = useState<AdminSessionResponse | null>(null);

  const markUnauthenticated = useCallback(() => {
    clearStoredBearerToken();
    setSession(null);
    setStatus('UNAUTHENTICATED');
  }, []);

  const api = useMemo(
    () =>
      createAdminApiClient({
        baseUrl: webConfig.NEXT_PUBLIC_API_BASE_URL,
        getBearerToken: getStoredBearerToken,
        onUnauthorized: markUnauthenticated,
      }),
    [markUnauthenticated],
  );

  const refreshSession = useCallback(async () => {
    try {
      const next = await api.getSession();
      setSession(next);
      setStatus('AUTHENTICATED');
    } catch {
      markUnauthenticated();
    }
  }, [api, markUnauthenticated]);

  const setSessionFromLogin = useCallback(
    async (sessionToken: string) => {
      setStoredBearerToken(sessionToken);
      await refreshSession();
    },
    [refreshSession],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Clear local session even if revoke fails.
    }
    markUnauthenticated();
  }, [api, markUnauthenticated]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      status,
      session,
      api,
      setSessionFromLogin,
      refreshSession,
      logout,
      markUnauthenticated,
    }),
    [status, session, api, setSessionFromLogin, refreshSession, logout, markUnauthenticated],
  );

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession(): AdminSessionContextValue {
  const ctx = useContext(AdminSessionContext);
  if (ctx === null) {
    throw new Error('useAdminSession must be used within AdminSessionProvider');
  }
  return ctx;
}
