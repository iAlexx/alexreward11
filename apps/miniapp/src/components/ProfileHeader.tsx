'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useAuth } from '../providers/AuthProvider';

export function ProfileHeader() {
  const t = useTranslations('app');
  const { user } = useAuth();
  const display =
    user?.username !== null && user?.username !== undefined && user.username.trim() !== ''
      ? `@${user.username}`
      : (user?.firstName ?? t('brand'));

  return (
    <header className="alex-profile-header">
      <div>
        <p className="alex-brand">{t('brand')}</p>
        <p className="alex-muted alex-profile-header__user">{display}</p>
      </div>
      <Link href="/profile" className="alex-chip-link" aria-label={t('openProfile')}>
        {display.slice(0, 1).toUpperCase()}
      </Link>
    </header>
  );
}
