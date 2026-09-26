'use client';

import type { ReactNode } from 'react';

import { AdminSessionGuard } from '../../components/AdminSessionGuard';
import { AppShell } from '../../components/AppShell';

export default function OpsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <AdminSessionGuard>
      <AppShell>{children}</AppShell>
    </AdminSessionGuard>
  );
}
