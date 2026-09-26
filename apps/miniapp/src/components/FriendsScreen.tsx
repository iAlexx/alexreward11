'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';

export function FriendsScreen() {
  const t = useTranslations('friends');
  const { api } = useAuth();

  const referrals = useQuery({
    queryKey: queryKeys.referrals,
    queryFn: () => api.getReferralsSummary(),
  });

  if (referrals.isLoading) return <DomainStateView state="LOADING" />;
  if (referrals.isError || referrals.data === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void referrals.refetch()} />;
  }

  const data = referrals.data;
  return (
    <div className="alex-stack">
      <h1 className="alex-title">{t('title')}</h1>
      <p className="alex-muted">{t('rewardNote')}</p>
      <DomainStateView
        state={data.status}
        reasonCode={data.reasonCode}
        emptyTitle={t('empty')}
        unavailableTitle={t('engineTitle')}
        unavailableBody={t('engineBody')}
        onRetry={
          data.reasonCode === 'ENGINE_NOT_ENABLED' ? undefined : () => void referrals.refetch()
        }
      >
        {data.status === 'READY' && data.data !== null ? (
          <section className="alex-card">
            <h2 className="alex-title-sm">{t('stats')}</h2>
            <dl className="alex-kv">
              <div>
                <dt>{t('referralCode')}</dt>
                <dd>{data.data.referralCode ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('invitedCount')}</dt>
                <dd>{data.data.invitedCount}</dd>
              </div>
              <div>
                <dt>{t('activatedCount')}</dt>
                <dd>{data.data.activatedCount}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </DomainStateView>
    </div>
  );
}
