'use client';

import { useTranslations } from 'next-intl';

import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { LootraBrand } from './LootraBrand';
import { IconBell, IconUser } from './NavIcons';

export function LootraHeader() {
  const t = useTranslations('app');
  const { user } = useAuth();
  const initial =
    user?.username !== null && user?.username !== undefined && user.username.trim() !== ''
      ? user.username.trim().slice(0, 1).toUpperCase()
      : (user?.firstName?.trim().slice(0, 1).toUpperCase() ?? 'L');

  return (
    <header className="lootra-header">
      <div className="lootra-topbar">
        <LootraBrand />
        <div className="lootra-top-actions">
          <AppLink
            href="/notifications"
            className="lootra-icon-btn"
            aria-label={t('openNotifications')}
          >
            <IconBell size={20} />
          </AppLink>
          <AppLink href="/profile" className="lootra-avatar-btn" aria-label={t('openProfile')}>
            <span className="lootra-avatar">
              {initial !== '' ? initial : <IconUser size={18} />}
            </span>
          </AppLink>
        </div>
      </div>
    </header>
  );
}
