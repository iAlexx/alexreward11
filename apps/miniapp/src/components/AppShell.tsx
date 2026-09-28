'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { BottomNav } from './BottomNav';
import { LootraHeader } from './LootraHeader';
import { OnboardingGate } from './OnboardingGate';

export function AppShell({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('app');

  return (
    <OnboardingGate>
      <div className="alex-shell lootra-shell">
        <a className="alex-skip" href="#main">
          {t('skipToContent')}
        </a>
        <span className="lootra-ambient" aria-hidden="true" />
        <LootraHeader />
        <main id="main" className="alex-main" aria-label={t('mainLabel')}>
          {children}
        </main>
        <BottomNav />
      </div>
    </OnboardingGate>
  );
}
