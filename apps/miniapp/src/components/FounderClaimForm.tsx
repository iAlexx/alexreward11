'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';

/**
 * Founder claim form.
 *
 * The claim code is held only in React state, never browser storage,
 * never logged, and cleared after any terminal response (success or failure).
 */
export function FounderClaimForm() {
  const t = useTranslations('founder');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [claimCode, setClaimCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const clearCode = () => {
    setClaimCode('');
    if (inputRef.current !== null) inputRef.current.value = '';
  };

  const mutation = useMutation({
    mutationFn: async (code: string) => api.claimFounder(code),
    onSuccess: async () => {
      clearCode();
      setError(null);
      setMessage(t('claimSuccess'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.membership });
      await queryClient.invalidateQueries({ queryKey: queryKeys.entitlements });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
    onError: (err: unknown) => {
      clearCode();
      setMessage(null);
      if (err instanceof ApiError) {
        if (err.status === 429) setError(t('claimRateLimited'));
        else if (err.status === 400 || err.status === 403 || err.status === 409) {
          setError(t('claimRejected'));
        } else setError(t('claimFailed'));
      } else {
        setError(t('claimFailed'));
      }
    },
  });

  useEffect(() => {
    return () => {
      // Ensure no claim code lingers when leaving the screen.
      setClaimCode('');
    };
  }, []);

  return (
    <section className="alex-card" aria-label={t('claimRegion')}>
      <h2 className="alex-title-sm">{t('claim')}</h2>
      <p className="alex-muted">{t('claimCodeHelp')}</p>
      <form
        className="alex-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const code = claimCode.trim();
          if (code === '' || mutation.isPending) return;
          mutation.mutate(code);
        }}
      >
        <label className="alex-field">
          <span>{t('claimCodeLabel')}</span>
          <input
            ref={inputRef}
            type="text"
            name="founder-claim-code"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={claimCode}
            disabled={mutation.isPending}
            onChange={(event) => {
              setClaimCode(event.target.value);
              setError(null);
              setMessage(null);
            }}
          />
        </label>
        <button type="submit" className="alex-button" disabled={mutation.isPending || claimCode.trim() === ''}>
          {mutation.isPending ? t('claimSubmitting') : t('claimSubmit')}
        </button>
      </form>
      {message !== null ? (
        <p className="alex-banner alex-banner--ok" role="status">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <p className="alex-banner alex-banner--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function FounderStatusPanel() {
  const t = useTranslations('founder');
  const common = useTranslations('common');
  const { api } = useAuth();

  const membership = useQuery({
    queryKey: queryKeys.membership,
    queryFn: () => api.getMembership(),
  });
  const entitlements = useQuery({
    queryKey: queryKeys.entitlements,
    queryFn: () => api.getEntitlements(),
  });

  if (membership.isLoading) {
    return <DomainStateView state="LOADING" />;
  }
  if (membership.isError) {
    return <DomainStateView state="ERROR" onRetry={() => void membership.refetch()} />;
  }

  const view = membership.data;
  if (view === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void membership.refetch()} />;
  }

  return (
    <div className="alex-stack">
      <section className="alex-card">
        <h2 className="alex-title-sm">{t('statusTitle')}</h2>
        {view.isFounder ? (
          <>
            <p className="alex-badge">{t('badge')}</p>
            {view.founderNumber !== null ? (
              <p className="alex-title">{t('number', { number: view.founderNumber })}</p>
            ) : null}
            {view.planCode !== null ? (
              <p className="alex-muted">
                {t('planCode')}: {view.planCode}
              </p>
            ) : null}
            {view.grantedAt !== null ? (
              <p className="alex-meta">
                {t('grantedAt')}: {view.grantedAt}
              </p>
            ) : null}
            {view.claimedAt !== null ? (
              <p className="alex-meta">
                {t('claimedAt')}: {view.claimedAt}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="alex-title-sm">{t('notFounderTitle')}</p>
            <p className="alex-muted">{t('notFounderBody')}</p>
          </>
        )}
        <p className="alex-muted">{t('securityNote')}</p>
        <p className="alex-meta">
          securityBypass: {common('no')} ({String(view.securityBypass)})
        </p>
      </section>

      {!view.isFounder ? <FounderClaimForm /> : null}

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('entitlementsTitle')}</h2>
        {entitlements.isLoading ? (
          <DomainStateView state="LOADING" />
        ) : entitlements.isError ? (
          <DomainStateView
            state="UNAVAILABLE"
            unavailableTitle={t('entitlementsUnavailable')}
            onRetry={() => void entitlements.refetch()}
          />
        ) : entitlements.data !== undefined && entitlements.data.entitlements.length === 0 ? (
          <DomainStateView state="EMPTY" emptyTitle={t('entitlementsEmpty')} />
        ) : (
          <ul className="alex-list">
            {(entitlements.data?.entitlements ?? []).map((item) => (
              <li key={item.code}>
                <strong>{item.name}</strong>
                {item.description !== null ? (
                  <span className="alex-muted"> — {item.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="alex-muted">{t('benefitsNote')}</p>
      </section>
    </div>
  );
}
