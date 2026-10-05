'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { EarnSkeleton } from './EarnSkeleton';
import { WatchEarnCard } from './WatchEarnCard';

export function EarnScreen() {
  const t = useTranslations('earn');
  const common = useTranslations('common');
  const { api } = useAuth();

  const earn = useQuery({
    queryKey: queryKeys.earnSummary('ADSGRAM'),
    queryFn: () => api.getEarnSummary('ADSGRAM'),
  });

  if (earn.isLoading) return <EarnSkeleton />;
  if (earn.isError || earn.data === undefined) {
    return (
      <div className="alex-stack lootra-earn">
        <h1 className="alex-title">{t('title')}</h1>
        <DomainStateView state="ERROR" onRetry={() => void earn.refetch()} />
      </div>
    );
  }

  const summary = earn.data;

  if (summary.status === 'UNAVAILABLE') {
    return (
      <div className="alex-stack lootra-earn">
        <EarnHero />
        <DomainStateView
          state="UNAVAILABLE"
          reasonCode={summary.reasonCode}
          onRetry={() => void earn.refetch()}
        />
      </div>
    );
  }

  if (summary.status === 'EMPTY' || summary.providers.length === 0) {
    return (
      <div className="alex-stack lootra-earn">
        <EarnHero />
        <DomainStateView
          state="EMPTY"
          emptyTitle={t('notConfiguredTitle')}
          emptyBody={t('notConfiguredBody')}
        />
      </div>
    );
  }

  const provider = summary.providers[0];
  if (provider === undefined) {
    return (
      <div className="alex-stack lootra-earn">
        <EarnHero />
        <DomainStateView state="EMPTY" emptyTitle={t('notConfiguredTitle')} />
      </div>
    );
  }

  const degraded = provider.health.status === 'DEGRADED';

  return (
    <div className="alex-stack lootra-earn">
      <EarnHero />
      <p className="alex-meta">{common('asOf', { time: summary.asOf })}</p>
      <DomainStateView state={degraded ? 'DEGRADED' : 'READY'}>
        <WatchEarnCard provider={provider} />
      </DomainStateView>
    </div>
  );
}

function EarnHero() {
  const t = useTranslations('earn');

  return (
    <header className="lootra-earn-hero">
      <div className="lootra-earn-hero__copy">
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-muted">{t('heroSubtitle')}</p>
        <p className="alex-meta">{t('variableRewardNotice')}</p>
      </div>
      <div className="lootra-earn-hero__visual" aria-hidden="true">
        <span className="lootra-earn-hero__orbit" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-earn-hero__art"
          src="/brand/lootra/rewards-hero.png"
          alt=""
          width={220}
          height={220}
        />
      </div>
    </header>
  );
}
