'use client';

import type { HomeLatestWithdrawalData } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import { AppLink } from './AppLink';

export function HomeWithdrawalPreview({
  status,
  data,
}: {
  readonly status: 'READY' | 'EMPTY' | 'UNAVAILABLE';
  readonly data: HomeLatestWithdrawalData | null;
}) {
  const t = useTranslations('home');
  const common = useTranslations('common');

  if (status === 'EMPTY' || (status === 'READY' && data === null)) {
    return null;
  }

  if (status === 'UNAVAILABLE') {
    return (
      <section className="lootra-home-card" aria-labelledby="lootra-wd-title">
        <h2 id="lootra-wd-title" className="alex-title-sm">
          {t('withdrawal')}
        </h2>
        <p className="alex-muted">{common('unavailable')}</p>
      </section>
    );
  }

  if (data === null) return null;

  const net = isAtomicAmountString(data.netAmountAtomic)
    ? formatAtomicAmountGrouped(data.netAmountAtomic)
    : '—';

  return (
    <section className="lootra-home-card lootra-withdrawal-preview" aria-labelledby="lootra-wd-title">
      <div className="lootra-today-head">
        <h2 id="lootra-wd-title" className="alex-title-sm">
          {t('withdrawal')}
        </h2>
        <span className="alex-badge">{t('withdrawalStateLabel', { state: data.state })}</span>
      </div>
      <dl className="alex-kv">
        <div>
          <dt>{t('withdrawalNet')}</dt>
          <dd>
            {net}{' '}
            <span className="alex-meta">{common('baseUnits')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('withdrawalRequestedAt')}</dt>
          <dd>{data.requestedAt}</dd>
        </div>
      </dl>
      <AppLink href="/wallet" className="lootra-btn lootra-btn--ghost">
        {t('viewWallet')}
      </AppLink>
    </section>
  );
}
