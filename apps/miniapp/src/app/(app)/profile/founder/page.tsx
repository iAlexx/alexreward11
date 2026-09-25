'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { FounderStatusPanel } from '../../../../components/FounderClaimForm';

export default function FounderPage() {
  const t = useTranslations('founder');
  const common = useTranslations('common');

  return (
    <div className="alex-stack">
      <Link href="/profile" className="alex-chip-link">
        ← {common('back')}
      </Link>
      <h1 className="alex-title">{t('title')}</h1>
      <FounderStatusPanel />
    </div>
  );
}
