'use client';

import { isLocaleCode, type LocaleCode } from '@alex-rewards/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';

const LOCALES: readonly LocaleCode[] = ['ar', 'en', 'ru'];

export function ProfileScreen() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const { api, signOut, setPreferredLocale, user } = useAuth();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.getSettings(),
  });

  const patchLocale = useMutation({
    mutationFn: (preferredLocale: LocaleCode) => api.patchSettings({ preferredLocale }),
    onSuccess: async (result) => {
      setPreferredLocale(result.preferredLocale);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
  });

  if (settings.isLoading) return <DomainStateView state="LOADING" />;
  if (settings.isError || settings.data === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void settings.refetch()} />;
  }

  const data = settings.data;

  return (
    <div className="alex-stack">
      <h1 className="alex-title">{t('title')}</h1>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('accountStatus')}</h2>
        <p className="alex-muted">
          {user?.username !== null && user?.username !== undefined && user.username.trim() !== ''
            ? `@${user.username}`
            : (user?.firstName ?? '—')}
        </p>
        <p className="alex-meta">
          {user?.status} · {user?.withdrawalStatus}
        </p>
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('membershipTitle')}</h2>
        <Link href="/profile/founder" className="alex-chip-link">
          {t('founderEntry')}
        </Link>
        <p className="alex-muted">{t('founderEntryBody')}</p>
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('language')}</h2>
        <div className="alex-locale-row">
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              className={
                data.preferredLocale === locale
                  ? 'alex-button alex-button--ghost is-active'
                  : 'alex-button alex-button--ghost'
              }
              disabled={patchLocale.isPending}
              onClick={() => {
                if (!isLocaleCode(locale)) return;
                patchLocale.mutate(locale);
              }}
            >
              {locale.toUpperCase()}
            </button>
          ))}
        </div>
        {patchLocale.isPending ? <p className="alex-muted">{t('languageSaving')}</p> : null}
        {patchLocale.isSuccess ? (
          <p className="alex-banner alex-banner--ok" role="status">
            {t('languageSaved')}
          </p>
        ) : null}
        {patchLocale.isError ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {patchLocale.error instanceof ApiError ? t('languageError') : t('languageError')}
          </p>
        ) : null}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('payoutPrivacyTitle')}</h2>
        <p className="alex-muted">
          {data.publicPayoutIdentityMode === 'SHOW_USERNAME'
            ? t('payoutPrivacyShowUsername')
            : t('payoutPrivacyHideIdentity')}
        </p>
        <p className="alex-meta">{t('payoutPrivacyReadOnly')}</p>
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('notificationsTitle')}</h2>
        <dl className="alex-kv">
          <div>
            <dt>{t('notificationsMarketing')}</dt>
            <dd>{data.marketingNotificationsEnabled ? common('on') : common('off')}</dd>
          </div>
          <div>
            <dt>{t('notificationsSecurity')}</dt>
            <dd>
              {common('on')} — {t('notificationsSecurityLocked')}
            </dd>
          </div>
        </dl>
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('legalTitle')}</h2>
        <p className="alex-muted">{t('linkNotConfigured')}</p>
      </section>

      <button
        type="button"
        className="alex-button alex-button--ghost"
        onClick={() => {
          void signOut();
        }}
      >
        {t('logout')}
      </button>
    </div>
  );
}
