'use client';

import { useTranslations } from 'next-intl';

import { AppLink } from '../../../../components/AppLink';
import { FounderStatusPanel } from '../../../../components/FounderClaimForm';

export default function FounderPage() {
  const t = useTranslations('founder');
  const common = useTranslations('common');

  return (
    <div className="alex-stack">
      <AppLink href="/profile" className="alex-chip-link">
        ← {common('back')}
      </AppLink>
      <h1 className="alex-title">{t('title')}</h1>
      <FounderStatusPanel />
    </div>
  );
}
