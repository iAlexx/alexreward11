'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { strings } from '../lib/strings';
import { useAdminSession } from '../providers/AdminSessionProvider';

/** Cookie/Bearer AdminSessionGuard — redirects unauthenticated users to /login. */
export function AdminSessionGuard({ children }: { readonly children: ReactNode }) {
  const { status } = useAdminSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'UNAUTHENTICATED') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status === 'LOADING') {
    return (
      <div className="admin-state" role="status" aria-live="polite">
        <p className="admin-muted">{strings.loading}</p>
      </div>
    );
  }

  if (status !== 'AUTHENTICATED') {
    return null;
  }

  return <>{children}</>;
}
