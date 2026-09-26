'use client';

import type { BalanceBucketDto } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';

export function MoneyAmount({
  bucket,
  label,
}: {
  readonly bucket: BalanceBucketDto;
  readonly label: string;
}) {
  const t = useTranslations('common');
  const home = useTranslations('home');

  if (bucket.state === 'UNAVAILABLE') {
    return (
      <div className="alex-money">
        <span className="alex-money__label">{label}</span>
        <span className="alex-money__value alex-muted">{home('balanceUnavailable')}</span>
      </div>
    );
  }

  const display = isAtomicAmountString(bucket.amountAtomic)
    ? formatAtomicAmount(bucket.amountAtomic)
    : '—';

  return (
    <div className="alex-money">
      <span className="alex-money__label">{label}</span>
      <span className="alex-money__value">
        {display}{' '}
        <span className="alex-money__symbol">{bucket.assetSymbol}</span>
      </span>
      <span className="alex-meta">{t('baseUnits')}</span>
    </div>
  );
}
