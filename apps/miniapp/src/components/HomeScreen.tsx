'use client';

import type { DomainEnvelope, HomeSummaryResponse } from '@alex-rewards/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { DomainStateView, type UiDomainState } from './DomainState';
import { MoneyAmount } from './MoneyAmount';
import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';

function envelopeState<T>(envelope: DomainEnvelope<T>): UiDomainState {
  return envelope.status;
}

export function HomeScreen() {
  const t = useTranslations('home');
  const common = useTranslations('common');
  const { api } = useAuth();

  const home = useQuery({
    queryKey: queryKeys.home,
    queryFn: () => api.getHome(),
  });

  if (home.isLoading) return <DomainStateView state="LOADING" />;
  if (home.isError || home.data === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void home.refetch()} />;
  }

  const data: HomeSummaryResponse = home.data;
  const degraded = Object.values(data)
    .filter((value): value is DomainEnvelope<unknown> => {
      return (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        typeof (value as DomainEnvelope<unknown>).status === 'string'
      );
    })
    .some((envelope) => envelope.status === 'UNAVAILABLE');

  return (
    <div className="alex-stack">
      <header>
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-meta">{common('asOf', { time: data.asOf })}</p>
        <p className="alex-muted">{common('serverTruth')}</p>
      </header>

      <DomainStateView state={degraded ? 'DEGRADED' : 'READY'}>
        <section className="alex-card">
          <h2 className="alex-title-sm">{t('balancesTitle')}</h2>
          <DomainStateView
            state={envelopeState(data.balances)}
            reasonCode={data.balances.errorCode}
            onRetry={() => void home.refetch()}
          >
            {data.balances.data !== null ? (
              <div className="alex-stack-sm">
                <MoneyAmount bucket={data.balances.data.available} label={t('balanceAvailable')} />
                <MoneyAmount bucket={data.balances.data.pending} label={t('balancePending')} />
                <MoneyAmount bucket={data.balances.data.reserved} label={t('balanceReserved')} />
                <MoneyAmount
                  bucket={data.balances.data.lifetimeEarned}
                  label={t('balanceLifetime')}
                />
                <p className="alex-meta">{common('baseUnitsNote')}</p>
              </div>
            ) : null}
          </DomainStateView>
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('today')}</h2>
          <DomainStateView
            state={envelopeState(data.todayAds)}
            reasonCode={data.todayAds.errorCode}
          >
            {data.todayAds.data !== null ? (
              <dl className="alex-kv">
                <div>
                  <dt>{t('todayProviderAvailability')}</dt>
                  <dd>{data.todayAds.data.providerCode}</dd>
                </div>
                <div>
                  <dt>{t('todayOpportunitiesRemaining')}</dt>
                  <dd>{data.todayAds.data.successRemaining ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t('todayRequestAttemptsRemaining')}</dt>
                  <dd>{data.todayAds.data.requestRemaining ?? '—'}</dd>
                </div>
                {!data.todayAds.data.monetaryEligible ? (
                  <div>
                    <dt>{t('todayEarnings')}</dt>
                    <dd>{t('todayRewardsDisabled')}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </DomainStateView>
          <AppLink href="/earn" className="alex-button alex-button--ghost">
            {t('openEarn')}
          </AppLink>
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('missions')}</h2>
          <DomainStateView
            state={envelopeState(data.missions)}
            reasonCode={data.missions.errorCode}
            unavailableTitle={t('missions')}
            unavailableBody={common('engineNotEnabled')}
          />
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('referral')}</h2>
          <DomainStateView
            state={envelopeState(data.referrals)}
            reasonCode={data.referrals.errorCode}
            unavailableBody={common('engineNotEnabled')}
          />
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('withdrawal')}</h2>
          <DomainStateView
            state={envelopeState(data.latestWithdrawal)}
            reasonCode={data.latestWithdrawal.errorCode}
            emptyTitle={t('withdrawalNone')}
          >
            {data.latestWithdrawal.data !== null ? (
              <dl className="alex-kv">
                <div>
                  <dt>{t('withdrawalState')}</dt>
                  <dd>{data.latestWithdrawal.data.state}</dd>
                </div>
                <div>
                  <dt>{t('withdrawalNet')}</dt>
                  <dd>
                    {isAtomicAmountString(data.latestWithdrawal.data.netAmountAtomic)
                      ? formatAtomicAmount(data.latestWithdrawal.data.netAmountAtomic)
                      : '—'}{' '}
                    <span className="alex-meta">{common('baseUnits')}</span>
                  </dd>
                </div>
              </dl>
            ) : null}
          </DomainStateView>
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('announcement')}</h2>
          <DomainStateView
            state={envelopeState(data.announcement)}
            reasonCode={data.announcement.errorCode}
            emptyTitle={t('noAnnouncement')}
          >
            {data.announcement.data !== null ? (
              <p>{data.announcement.data.title ?? data.announcement.data.typeCode}</p>
            ) : null}
          </DomainStateView>
        </section>

        <section className="alex-card">
          <h2 className="alex-title-sm">{t('membership')}</h2>
          <DomainStateView
            state={envelopeState(data.membershipBrief)}
            reasonCode={data.membershipBrief.errorCode}
          >
            {data.membershipBrief.data !== null ? (
              <>
                <p>
                  {data.membershipBrief.data.isFounder
                    ? t('membershipFounder')
                    : t('membershipStandard')}
                </p>
                <AppLink href="/profile/founder" className="alex-chip-link">
                  {t('openFounder')}
                </AppLink>
              </>
            ) : null}
          </DomainStateView>
        </section>
      </DomainStateView>
    </div>
  );
}
