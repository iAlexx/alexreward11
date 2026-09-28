'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ReferralsSummaryData } from '@alex-rewards/contracts';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { EngineUnavailableState } from './EngineUnavailableState';
import { FriendsSkeleton } from './TasksFriendsSkeleton';

function FriendsHero() {
  const t = useTranslations('friends');

  return (
    <header className="lootra-friends-hero">
      <div className="lootra-friends-hero__copy">
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-muted">{t('heroSubtitle')}</p>
      </div>
      <div className="lootra-friends-hero__visual" aria-hidden="true">
        <span className="lootra-friends-hero__orbit" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand accent */}
        <img
          className="lootra-friends-hero__art"
          src="/brand/lootra/bot-hero.png"
          alt=""
          width={180}
          height={180}
        />
      </div>
    </header>
  );
}

function ReferralReadySummary({ data }: { readonly data: ReferralsSummaryData }) {
  const t = useTranslations('friends');
  const common = useTranslations('common');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copyCode() {
    if (data.referralCode === null || data.referralCode === '') return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(data.referralCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <section className="lootra-friends-card" aria-labelledby="lootra-friends-stats">
      <h2 id="lootra-friends-stats" className="alex-title-sm">
        {t('stats')}
      </h2>
      <p className="alex-muted">{t('rewardNote')}</p>

      <dl className="lootra-friends-stats">
        <div>
          <dt>{t('invitedCount')}</dt>
          <dd>{data.invitedCount}</dd>
        </div>
        <div>
          <dt>{t('activatedCount')}</dt>
          <dd>{data.activatedCount}</dd>
        </div>
      </dl>

      {data.referralCode !== null && data.referralCode !== '' ? (
        <div className="lootra-referral-code">
          <p className="alex-meta">{t('referralCode')}</p>
          <p className="lootra-referral-code__value" dir="ltr">
            {data.referralCode}
          </p>
          <button type="button" className="lootra-btn lootra-btn--ghost" onClick={() => void copyCode()}>
            {copied ? common('copied') : t('copyCode')}
          </button>
          {copyFailed ? (
            <p className="alex-banner alex-banner--warn" role="alert">
              {t('copyFailed')}
            </p>
          ) : null}
          {copied ? (
            <p className="alex-meta" role="status" aria-live="polite">
              {common('copied')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Friends / Referrals screen.
 * ENGINE_NOT_ENABLED must not invent zeros, people, earnings, or invite links.
 * READY summary shows only server invitedCount / activatedCount / referralCode.
 */
export function FriendsScreen() {
  const t = useTranslations('friends');
  const { api } = useAuth();

  const referrals = useQuery({
    queryKey: queryKeys.referrals,
    queryFn: () => api.getReferralsSummary(),
  });

  if (referrals.isLoading) return <FriendsSkeleton />;

  if (referrals.isError || referrals.data === undefined) {
    return (
      <div className="alex-stack lootra-friends">
        <FriendsHero />
        <DomainStateView state="ERROR" onRetry={() => void referrals.refetch()} />
      </div>
    );
  }

  const data = referrals.data;
  const engineDisabled =
    data.status === 'UNAVAILABLE' && data.reasonCode === 'ENGINE_NOT_ENABLED';

  return (
    <div className="alex-stack lootra-friends">
      <FriendsHero />

      {engineDisabled ? (
        <EngineUnavailableState variant="friends" />
      ) : data.status === 'UNAVAILABLE' ? (
        <DomainStateView
          state="UNAVAILABLE"
          reasonCode={data.reasonCode}
          unavailableTitle={t('unavailable')}
          unavailableBody={t('engineBody')}
          onRetry={() => void referrals.refetch()}
        />
      ) : data.status === 'READY' && data.data !== null ? (
        <ReferralReadySummary data={data.data} />
      ) : data.status === 'READY' ? (
        <DomainStateView state="EMPTY" emptyTitle={t('empty')} />
      ) : (
        <DomainStateView
          state={data.status}
          reasonCode={data.reasonCode}
          onRetry={() => void referrals.refetch()}
        />
      )}
    </div>
  );
}
