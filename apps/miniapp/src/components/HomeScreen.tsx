'use client';

import type { HomeSummaryResponse } from '@alex-rewards/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { resolveGreetingName, resolveGreetingPeriod } from '../lib/home/home-greeting';
import { deriveHomeSmartAction } from '../lib/home/home-smart-action';
import { deriveHomeSurfaceState } from '../lib/home/home-surface';
import { resolveHomeWalletCta } from '../lib/home/home-wallet-cta';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { HomeAnnouncementCard } from './HomeAnnouncementCard';
import { HomeBalanceHero } from './HomeBalanceHero';
import { HomeMembershipBrief } from './HomeMembershipBrief';
import { HomeSkeleton } from './HomeSkeleton';
import { HomeSmartAction } from './HomeSmartAction';
import { HomeTodaySection } from './HomeTodaySection';
import { HomeWithdrawalPreview } from './HomeWithdrawalPreview';

export function HomeScreen() {
  const t = useTranslations('home');
  const common = useTranslations('common');
  const { api, user } = useAuth();

  const home = useQuery({
    queryKey: queryKeys.home,
    queryFn: () => api.getHome(),
  });

  const wallets = useQuery({
    queryKey: queryKeys.wallets,
    queryFn: () => api.getWallets(),
  });

  const earn = useQuery({
    queryKey: queryKeys.earnSummary('ADSGRAM'),
    queryFn: () => api.getEarnSummary('ADSGRAM'),
  });

  if (home.isLoading) return <HomeSkeleton />;
  if (home.isError || home.data === undefined) {
    return (
      <div className="lootra-home-error alex-stack">
        <DomainStateView state="ERROR" onRetry={() => void home.refetch()} />
      </div>
    );
  }

  const data: HomeSummaryResponse = home.data;
  const surface = deriveHomeSurfaceState(data);

  const walletCta = resolveHomeWalletCta({
    wallets: wallets.data,
    walletsQueryFailed: wallets.isError,
    walletsQueryPending: wallets.isPending && wallets.data === undefined,
  });

  const smartAction = deriveHomeSmartAction({
    home: data,
    walletCtaKind: walletCta.kind,
    earnSummary: earn.data,
  });

  const period = resolveGreetingPeriod();
  const name = resolveGreetingName(user?.firstName, t('memberFallback'));

  return (
    <div className="alex-stack lootra-home">
      <header className="lootra-home-header">
        <p className="lootra-home-greeting">{t(`greeting_${period}`, { name })}</p>
        <p className="alex-meta">{common('asOf', { time: data.asOf })}</p>
      </header>

      <DomainStateView state={surface === 'DEGRADED' ? 'DEGRADED' : 'READY'}>
        <HomeBalanceHero
          balances={data.balances.data}
          balancesStatus={data.balances.status}
          cta={walletCta}
          onRetry={
            data.balances.status === 'UNAVAILABLE' ? () => void home.refetch() : undefined
          }
        />

        {smartAction !== null ? <HomeSmartAction action={smartAction} /> : null}

        <HomeTodaySection
          status={data.todayAds.status}
          data={data.todayAds.data}
          reasonCode={data.todayAds.errorCode}
        />

        <HomeWithdrawalPreview
          status={data.latestWithdrawal.status}
          data={data.latestWithdrawal.data}
        />

        <HomeAnnouncementCard status={data.announcement.status} data={data.announcement.data} />

        <HomeMembershipBrief
          status={data.membershipBrief.status}
          data={data.membershipBrief.data}
        />
      </DomainStateView>
    </div>
  );
}
