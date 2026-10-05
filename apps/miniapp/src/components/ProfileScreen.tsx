'use client';

import {
  isLocaleCode,
  type LocaleCode,
  type PublicPayoutIdentityMode,
} from '@alex-rewards/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { privacyPolicyUrl, termsOfServiceUrl } from '../lib/env';
import {
  profileDisplayName,
  profileInitials,
} from '../lib/profile/profile-display';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { DomainStateView } from './DomainState';
import { ProfileSkeleton } from './ProfileSkeleton';

const LOCALES: readonly LocaleCode[] = ['ar', 'en', 'ru'];
const PAYOUT_MODES: readonly PublicPayoutIdentityMode[] = ['SHOW_USERNAME', 'HIDE_IDENTITY'];

/**
 * Profile settings + account surfaces.
 * Writable settings PATCH only preferredLocale and publicPayoutIdentityMode.
 * Support ticket flows live under /profile/support.
 */
export function ProfileScreen() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const { api, signOut, setPreferredLocale, user } = useAuth();
  const queryClient = useQueryClient();
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);

  const termsUrl = termsOfServiceUrl();
  const privacyUrl = privacyPolicyUrl();

  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.getSettings(),
  });

  const patchSettings = useMutation({
    mutationFn: (body: {
      preferredLocale?: LocaleCode;
      publicPayoutIdentityMode?: PublicPayoutIdentityMode;
    }) => api.patchSettings(body),
    onSuccess: async (result) => {
      setPreferredLocale(result.preferredLocale);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
  });

  const deletionRequest = useMutation({
    mutationFn: () => api.requestAccountDeletion(),
    onSuccess: async () => {
      setDeletionConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets });
      // Review request only — do not logout, clear session, or mutate balances.
    },
  });

  if (settings.isLoading) return <ProfileSkeleton />;
  if (settings.isError || settings.data === undefined) {
    return (
      <div className="alex-stack lootra-profile">
        <h1 className="alex-title">{t('title')}</h1>
        <DomainStateView state="ERROR" onRetry={() => void settings.refetch()} />
      </div>
    );
  }

  const data = settings.data;
  const rawName = user
    ? profileDisplayName({
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      })
    : '';
  const displayName = rawName === '' ? t('identityFallback') : rawName;
  const initials = user
    ? profileInitials({
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      })
    : 'L';

  return (
    <div className="alex-stack lootra-profile">
      <header className="lootra-profile-identity">
        <div className="lootra-profile-avatar" aria-hidden="true">
          {initials}
        </div>
        <div className="lootra-profile-identity__copy">
          <h1 className="alex-title">{t('title')}</h1>
          <p className="lootra-profile-name">{displayName}</p>
          <p className="alex-meta">
            {t('accountStatus')}: {user?.status ?? '—'}
            {' · '}
            {t('withdrawalStatusLabel')}: {user?.withdrawalStatus ?? '—'}
          </p>
        </div>
      </header>

      <nav className="lootra-profile-nav" aria-label={t('settings')}>
        <AppLink href="/profile/founder" className="lootra-profile-nav-card">
          <span className="lootra-profile-nav-card__title">{t('founderEntry')}</span>
          <span className="alex-muted">{t('founderEntryBody')}</span>
        </AppLink>
        <AppLink href="/profile/support" className="lootra-profile-nav-card">
          <span className="lootra-profile-nav-card__title">{t('support')}</span>
          <span className="alex-muted">{t('supportNavBody')}</span>
        </AppLink>
      </nav>

      <section className="lootra-profile-card" aria-labelledby="lootra-language">
        <h2 id="lootra-language" className="alex-title-sm">
          {t('language')}
        </h2>
        <div className="lootra-profile-chip-row" role="group" aria-label={t('language')}>
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              className={
                data.preferredLocale === locale
                  ? 'lootra-btn lootra-btn--ghost is-active'
                  : 'lootra-btn lootra-btn--ghost'
              }
              disabled={patchSettings.isPending}
              aria-pressed={data.preferredLocale === locale}
              onClick={() => {
                if (!isLocaleCode(locale)) return;
                patchSettings.mutate({ preferredLocale: locale });
              }}
            >
              {locale.toUpperCase()}
            </button>
          ))}
        </div>
        {patchSettings.isPending && patchSettings.variables?.preferredLocale !== undefined ? (
          <p className="alex-muted">{t('languageSaving')}</p>
        ) : null}
        {patchSettings.isSuccess && patchSettings.variables?.preferredLocale !== undefined ? (
          <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
            {t('languageSaved')}
          </p>
        ) : null}
        {patchSettings.isError && patchSettings.variables?.preferredLocale !== undefined ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('languageError')}
          </p>
        ) : null}
      </section>

      <section className="lootra-profile-card" aria-labelledby="lootra-privacy">
        <h2 id="lootra-privacy" className="alex-title-sm">
          {t('payoutPrivacyTitle')}
        </h2>
        <div className="lootra-profile-chip-row" role="group" aria-label={t('payoutPrivacyTitle')}>
          {PAYOUT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={
                data.publicPayoutIdentityMode === mode
                  ? 'lootra-btn lootra-btn--ghost is-active'
                  : 'lootra-btn lootra-btn--ghost'
              }
              disabled={patchSettings.isPending}
              aria-pressed={data.publicPayoutIdentityMode === mode}
              onClick={() => {
                patchSettings.mutate({ publicPayoutIdentityMode: mode });
              }}
            >
              {mode === 'SHOW_USERNAME'
                ? t('payoutPrivacyShowUsername')
                : t('payoutPrivacyHideIdentity')}
            </button>
          ))}
        </div>
        {patchSettings.isSuccess &&
        patchSettings.variables?.publicPayoutIdentityMode !== undefined ? (
          <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
            {t('payoutPrivacySaved')}
          </p>
        ) : null}
        {patchSettings.isError &&
        patchSettings.variables?.publicPayoutIdentityMode !== undefined ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('payoutPrivacyError')}
          </p>
        ) : null}
      </section>

      <section className="lootra-profile-card" aria-labelledby="lootra-notifications">
        <h2 id="lootra-notifications" className="alex-title-sm">
          {t('notificationsTitle')}
        </h2>
        {/* Read-only status — no writable toggles; marketing/security are not PATCH fields. */}
        <dl className="lootra-profile-status-list">
          <div>
            <dt>{t('notificationsMarketing')}</dt>
            <dd>
              {data.marketingNotificationsEnabled ? common('on') : common('off')}
              <span className="alex-meta"> — {t('notificationsMarketingReadonly')}</span>
            </dd>
          </div>
          <div>
            <dt>{t('notificationsSecurity')}</dt>
            <dd>
              {common('on')}
              <span className="alex-meta"> — {t('notificationsSecurityLocked')}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="lootra-profile-card" aria-labelledby="lootra-legal">
        <h2 id="lootra-legal" className="alex-title-sm">
          {t('legalTitle')}
        </h2>
        <div className="lootra-profile-chip-row">
          {termsUrl !== null ? (
            <a
              className="lootra-btn lootra-btn--ghost"
              href={termsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('terms')}
            </a>
          ) : (
            <p className="alex-muted">
              {t('terms')}: {t('linkNotConfigured')}
            </p>
          )}
          {privacyUrl !== null ? (
            <a
              className="lootra-btn lootra-btn--ghost"
              href={privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('privacy')}
            </a>
          ) : (
            <p className="alex-muted">
              {t('privacy')}: {t('linkNotConfigured')}
            </p>
          )}
        </div>
      </section>

      <section className="lootra-profile-card" aria-labelledby="lootra-deletion">
        <h2 id="lootra-deletion" className="alex-title-sm">
          {t('deletionTitle')}
        </h2>
        <p className="alex-muted">{t('deletionBody')}</p>
        <label className="alex-field alex-field--row">
          <input
            type="checkbox"
            checked={deletionConfirmed}
            onChange={(event) => {
              setDeletionConfirmed(event.target.checked);
            }}
          />
          <span>{t('deletionConfirmLabel')}</span>
        </label>
        <button
          type="button"
          className="lootra-btn lootra-btn--ghost"
          disabled={!deletionConfirmed || deletionRequest.isPending}
          onClick={() => {
            deletionRequest.mutate();
          }}
        >
          {deletionRequest.isPending ? t('deletionSubmitting') : t('deletionSubmit')}
        </button>
        {deletionRequest.isSuccess ? (
          <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
            {deletionRequest.data.created
              ? t('deletionCreated', { publicId: deletionRequest.data.ticket.publicId })
              : t('deletionExisting', { publicId: deletionRequest.data.ticket.publicId })}
          </p>
        ) : null}
        {deletionRequest.isError ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('deletionError')}
          </p>
        ) : null}
      </section>

      <button
        type="button"
        className="lootra-btn lootra-btn--ghost lootra-profile-logout"
        onClick={() => {
          void signOut();
        }}
      >
        {t('logout')}
      </button>
    </div>
  );
}
