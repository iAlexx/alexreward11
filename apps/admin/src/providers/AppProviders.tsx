'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { AdminSessionProvider } from './AdminSessionProvider';
import { ReauthProvider } from './ReauthProvider';

export function AppProviders({ children }: { readonly children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AdminSessionProvider>
        <ReauthProvider>{children}</ReauthProvider>
      </AdminSessionProvider>
    </QueryClientProvider>
  );
}
