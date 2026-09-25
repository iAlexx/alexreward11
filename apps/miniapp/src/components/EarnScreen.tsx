'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { WatchEarnCard } from './WatchEarnCard';

export function EarnScreen() {
  const t = useTranslations('earn');
  const common = useTranslations('common');
  const { api } = useAuth();

  const earn = useQuery({
    queryKey: queryKeys.earnSummary('ADSGRAM'),
    queryFn: () => api.getEarnSummary('ADSGRAM'),
  });

  if (earn.isLoading) return <DomainStateView state="LOADING" />;
  if (earn.isError || earn.data === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void earn.refetch()} />;
  }

  const summary = earn.data;
  if (summary.status === 'UNAVAILABLE') {
    return (
      <div className="alex-stack">
        <h1 className="alex-title">{t('title')}</h1>
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
      <div className="alex-stack">
        <h1 className="alex-title">{t('title')}</h1>
        <DomainStateView state="EMPTY" emptyTitle={t('notConfiguredTitle')} emptyBody={t('notConfiguredBody')} />
      </div>
    );
  }

  const provider = summary.providers[0];
  if (provider === undefined) {
    return <DomainStateView state="EMPTY" emptyTitle={t('notConfiguredTitle')} />;
  }

  const degraded = provider.health.status === 'DEGRADED';

  return (
    <div className="alex-stack">
      <header>
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-meta">{common('asOf', { time: summary.asOf })}</p>
        <p className="alex-muted">{common('serverTruth')}</p>
      </header>
      <DomainStateView state={degraded ? 'DEGRADED' : 'READY'}>
        <WatchEarnCard provider={provider} />
      </DomainStateView>
    </div>
  );
}
