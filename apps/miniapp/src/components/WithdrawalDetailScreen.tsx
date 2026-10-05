'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import {
  isKnownWithdrawalState,
  withdrawalStateMessageKey,
} from '../lib/wallet/withdrawal-states';
import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { DomainStateView } from './DomainState';

export function WithdrawalDetailScreen({ id }: { readonly id: string }) {
  const t = useTranslations('wallet');
  const common = useTranslations('common');
  const { api } = useAuth();

  const detail = useQuery({
    queryKey: queryKeys.withdrawal(id),
    queryFn: () => api.getWithdrawal(id),
  });

  if (detail.isLoading) {
    return (
      <div className="alex-stack lootra-wallet">
        <AppLink href="/wallet" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <DomainStateView state="LOADING" />
      </div>
    );
  }

  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="alex-stack lootra-wallet">
        <AppLink href="/wallet" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <h1 className="alex-title">{t('detailTitle')}</h1>
        {notFound ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('detailNotFound')}
          </p>
        ) : (
          <DomainStateView state="ERROR" onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  const item = detail.data;
  if (item === undefined) {
    return (
      <div className="alex-stack lootra-wallet">
        <AppLink href="/wallet" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <p className="alex-banner alex-banner--warn" role="alert">
          {t('detailNotFound')}
        </p>
      </div>
    );
  }

  const stateKey = withdrawalStateMessageKey(item.state);
  const stateLabel = isKnownWithdrawalState(item.state)
    ? t(stateKey as 'state_REQUESTED')
    : t('stateUnknown', { state: item.state });

  return (
    <div className="alex-stack lootra-wallet">
      <AppLink href="/wallet" className="alex-chip-link">
        ← {common('back')}
      </AppLink>
      <h1 className="alex-title">{t('detailTitle')}</h1>

      <section className="lootra-wallet-card alex-stack-sm">
        <p className="alex-meta">
          {t('withdrawalPublicId')}: {item.publicId}
        </p>
        <p className="alex-meta">
          {t('withdrawalState')}: {stateLabel}
        </p>
        <p className="alex-meta">
          {t('withdrawalRequested')}:{' '}
          {isAtomicAmountString(item.requestedAmountAtomic)
            ? formatAtomicAmountGrouped(item.requestedAmountAtomic)
            : '—'}{' '}
          <span>{common('baseUnits')}</span>
        </p>
        <p className="alex-meta">
          {t('withdrawalFee')}:{' '}
          {isAtomicAmountString(item.feeAmountAtomic)
            ? formatAtomicAmountGrouped(item.feeAmountAtomic)
            : '—'}
        </p>
        <p className="alex-meta">
          {t('youReceive')}:{' '}
          {isAtomicAmountString(item.netAmountAtomic)
            ? formatAtomicAmountGrouped(item.netAmountAtomic)
            : '—'}
        </p>
        {item.priorityReview ? <p className="alex-meta">{t('priorityReview')}</p> : null}
      </section>
    </div>
  );
}
