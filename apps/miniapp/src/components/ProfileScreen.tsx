'use client';

import {
  isLocaleCode,
  type LocaleCode,
  type PublicPayoutIdentityMode,
} from '@alex-rewards/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ApiError } from '../lib/api/client';
import { privacyPolicyUrl, termsOfServiceUrl } from '../lib/env';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { DomainStateView } from './DomainState';

const LOCALES: readonly LocaleCode[] = ['ar', 'en', 'ru'];

const PAYOUT_MODES: readonly PublicPayoutIdentityMode[] = ['SHOW_USERNAME', 'HIDE_IDENTITY'];

export function ProfileScreen() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const { api, signOut, setPreferredLocale, user } = useAuth();
  const queryClient = useQueryClient();
  const [supportSubject, setSupportSubject] = useState('');
  const [supportBody, setSupportBody] = useState('');
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);

  const termsUrl = termsOfServiceUrl();
  const privacyUrl = privacyPolicyUrl();

  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.getSettings(),
  });

  const tickets = useQuery({
    queryKey: queryKeys.supportTickets,
    queryFn: () => api.listSupportTickets(),
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

  const createTicket = useMutation({
    mutationFn: () => {
      const subject = supportSubject.trim();
      const body = supportBody.trim();
      return api.createSupportTicket({
        subject,
        category: 'GENERAL',
        ...(body === '' ? {} : { body }),
      });
    },
    onSuccess: async () => {
      setSupportSubject('');
      setSupportBody('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets });
    },
  });

  const deletionRequest = useMutation({
    mutationFn: () => api.requestAccountDeletion(),
    onSuccess: async () => {
      setDeletionConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets });
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
        <AppLink href="/profile/founder" className="alex-chip-link">
          {t('founderEntry')}
        </AppLink>
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
              disabled={patchSettings.isPending}
              onClick={() => {
                if (!isLocaleCode(locale)) return;
                patchSettings.mutate({ preferredLocale: locale });
              }}
            >
              {locale.toUpperCase()}
            </button>
          ))}
        </div>
        {patchSettings.isPending ? <p className="alex-muted">{t('languageSaving')}</p> : null}
        {patchSettings.isSuccess && patchSettings.variables?.preferredLocale !== undefined ? (
          <p className="alex-banner alex-banner--ok" role="status">
            {t('languageSaved')}
          </p>
        ) : null}
        {patchSettings.isError ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {t('languageError')}
          </p>
        ) : null}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('payoutPrivacyTitle')}</h2>
        <div className="alex-locale-row">
          {PAYOUT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={
                data.publicPayoutIdentityMode === mode
                  ? 'alex-button alex-button--ghost is-active'
                  : 'alex-button alex-button--ghost'
              }
              disabled={patchSettings.isPending}
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
          <p className="alex-banner alex-banner--ok" role="status">
            {t('payoutPrivacySaved')}
          </p>
        ) : null}
        {patchSettings.isError &&
        patchSettings.variables?.publicPayoutIdentityMode !== undefined ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {t('payoutPrivacyError')}
          </p>
        ) : null}
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
        <div className="alex-locale-row">
          {termsUrl !== null ? (
            <a className="alex-chip-link" href={termsUrl} target="_blank" rel="noreferrer">
              {t('terms')}
            </a>
          ) : (
            <p className="alex-muted">
              {t('terms')}: {t('linkNotConfigured')}
            </p>
          )}
          {privacyUrl !== null ? (
            <a className="alex-chip-link" href={privacyUrl} target="_blank" rel="noreferrer">
              {t('privacy')}
            </a>
          ) : (
            <p className="alex-muted">
              {t('privacy')}: {t('linkNotConfigured')}
            </p>
          )}
        </div>
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('support')}</h2>
        <p className="alex-muted">{t('supportHelp')}</p>
        <label className="alex-field">
          <span>{t('supportSubject')}</span>
          <input
            type="text"
            value={supportSubject}
            maxLength={200}
            onChange={(event) => {
              setSupportSubject(event.target.value);
            }}
          />
        </label>
        <label className="alex-field">
          <span>{t('supportBody')}</span>
          <textarea
            value={supportBody}
            maxLength={4000}
            rows={3}
            onChange={(event) => {
              setSupportBody(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="alex-button"
          disabled={createTicket.isPending || supportSubject.trim() === ''}
          onClick={() => {
            createTicket.mutate();
          }}
        >
          {createTicket.isPending ? t('supportSubmitting') : t('supportSubmit')}
        </button>
        {createTicket.isSuccess ? (
          <p className="alex-banner alex-banner--ok" role="status">
            {t('supportCreated', { publicId: createTicket.data.ticket.publicId })}
          </p>
        ) : null}
        {createTicket.isError ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {createTicket.error instanceof ApiError ? t('supportError') : t('supportError')}
          </p>
        ) : null}

        <h3 className="alex-title-sm">{t('supportTicketsTitle')}</h3>
        {tickets.isLoading ? <p className="alex-muted">{common('loading')}</p> : null}
        {tickets.isError ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {t('supportError')}
          </p>
        ) : null}
        {tickets.data !== undefined && tickets.data.tickets.length === 0 ? (
          <p className="alex-muted">{t('supportTicketsEmpty')}</p>
        ) : null}
        {tickets.data?.tickets.map((ticket) => (
          <p key={ticket.id} className="alex-meta">
            {ticket.publicId} · {ticket.state} · {ticket.subject}
          </p>
        ))}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('deletionTitle')}</h2>
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
          className="alex-button alex-button--ghost"
          disabled={!deletionConfirmed || deletionRequest.isPending}
          onClick={() => {
            deletionRequest.mutate();
          }}
        >
          {deletionRequest.isPending ? t('deletionSubmitting') : t('deletionSubmit')}
        </button>
        {deletionRequest.isSuccess ? (
          <p className="alex-banner alex-banner--ok" role="status">
            {deletionRequest.data.created
              ? t('deletionCreated', { publicId: deletionRequest.data.ticket.publicId })
              : t('deletionExisting', { publicId: deletionRequest.data.ticket.publicId })}
          </p>
        ) : null}
        {deletionRequest.isError ? (
          <p className="alex-banner alex-banner--error" role="alert">
            {t('deletionError')}
          </p>
        ) : null}
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
