'use client';

import type { HomeTodayAdsData } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

function remainingDisplay(value: number | null, unavailable: string): string {
  if (value === null) return unavailable;
  return String(value);
}

export function HomeTodaySection({
  status,
  data,
  reasonCode,
}: {
  readonly status: 'READY' | 'EMPTY' | 'UNAVAILABLE';
  readonly data: HomeTodayAdsData | null;
  readonly   reasonCode?: string | null | undefined;
}) {
  const t = useTranslations('home');
  const common = useTranslations('common');
  const earn = useTranslations('earn');

  if (status === 'UNAVAILABLE') {
    return (
      <section className="lootra-home-card" aria-labelledby="lootra-today-title">
        <h2 id="lootra-today-title" className="alex-title-sm">
          {t('today')}
        </h2>
        <p className="alex-muted">{common('unavailable')}</p>
        {reasonCode !== undefined && reasonCode !== null ? (
          <p className="alex-meta">
            {common('reasonCodes')}: {reasonCode}
          </p>
        ) : null}
      </section>
    );
  }

  if (status !== 'READY' || data === null) {
    return null;
  }

  const usageBasisLabel =
    data.requestUsageBasis === 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE'
      ? earn('usageBasisConservative')
      : data.requestUsageBasis === 'AUTHORITATIVE_PROVIDER_REQUEST'
        ? earn('usageBasisAuthoritativeRequest')
        : earn('usageBasisSuccessfulReward');

  return (
    <section className="lootra-home-card lootra-today" aria-labelledby="lootra-today-title">
      <div className="lootra-today-head">
        <h2 id="lootra-today-title" className="alex-title-sm">
          {t('today')}
        </h2>
        <span className="alex-badge">{data.providerCode}</span>
      </div>

      {!data.monetaryEligible ? (
        <p className="lootra-today-monetary" role="status">
          {t('monetaryRewardsUnavailable')}
        </p>
      ) : null}

      <dl className="alex-kv lootra-today-kv">
        <div>
          <dt>{t('todayOpportunitiesRemaining')}</dt>
          <dd>{remainingDisplay(data.successRemaining, t('limitUnconfigured'))}</dd>
        </div>
        <div>
          <dt>{t('todayRequestAttemptsRemaining')}</dt>
          <dd>{remainingDisplay(data.requestRemaining, t('limitUnconfigured'))}</dd>
        </div>
      </dl>
      <p className="alex-meta">{usageBasisLabel}</p>
    </section>
  );
}
