'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { BottomNav } from './BottomNav';
import { ProfileHeader } from './ProfileHeader';

export function AppShell({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('app');

  return (
    <div className="alex-shell">
      <a className="alex-skip" href="#main">
        {t('skipToContent')}
      </a>
      <ProfileHeader />
      <main id="main" className="alex-main" aria-label={t('mainLabel')}>
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
