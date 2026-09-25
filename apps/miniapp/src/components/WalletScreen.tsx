'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { MoneyAmount } from './MoneyAmount';

export function WalletScreen() {
  const t = useTranslations('wallet');
  const common = useTranslations('common');
  const { api } = useAuth();

  const balances = useQuery({
    queryKey: queryKeys.balances,
    queryFn: () => api.getBalances(),
  });
  const wallets = useQuery({
    queryKey: queryKeys.wallets,
    queryFn: () => api.getWallets(),
  });
  const withdrawals = useQuery({
    queryKey: queryKeys.withdrawals,
    queryFn: () => api.getWithdrawals(),
  });

  const loading = balances.isLoading || wallets.isLoading || withdrawals.isLoading;
  if (loading) return <DomainStateView state="LOADING" />;

  return (
    <div className="alex-stack">
      <header>
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-muted">{t('balanceHint')}</p>
        <p className="alex-muted">{t('payoutRequiresProof')}</p>
      </header>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('balancesTitle')}</h2>
        {balances.isError || balances.data === undefined ? (
          <DomainStateView state="ERROR" onRetry={() => void balances.refetch()} />
        ) : (
          <div className="alex-stack-sm">
            <MoneyAmount bucket={balances.data.available} label={t('balancesTitle')} />
            <p className="alex-meta">{common('baseUnitsNote')}</p>
          </div>
        )}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('walletsTitle')}</h2>
        {wallets.isError || wallets.data === undefined ? (
          <DomainStateView state="ERROR" onRetry={() => void wallets.refetch()} />
        ) : (
          <DomainStateView
            state={
              wallets.data.status === 'READY' && wallets.data.wallets.length === 0
                ? 'EMPTY'
                : wallets.data.status
            }
            emptyTitle={t('noWalletsTitle')}
            emptyBody={t('noWalletsBody')}
          >
            <p className="alex-meta">
              {t('network')}: {wallets.data.acceptedNetworkCode}
            </p>
            {wallets.data.withdrawalCooldownUntil !== null ? (
              <p className="alex-banner alex-banner--warn" role="status">
                {t('cooldownUntil', { time: wallets.data.withdrawalCooldownUntil })}
              </p>
            ) : null}
            <ul className="alex-list">
              {wallets.data.wallets.map((wallet) => (
                <li key={wallet.id} className="alex-stack-sm">
                  <p className="alex-title-sm">{wallet.friendlyAddress}</p>
                  <p className="alex-muted">
                    {wallet.isPrimary ? t('primary') : null}
                    {wallet.isPrimary ? ' · ' : null}
                    {wallet.verified ? t('verified') : t('notVerified')}
                    {wallet.disabledAt !== null ? ` · ${t('disabled')}` : null}
                  </p>
                  {wallet.verificationMethod !== null ? (
                    <p className="alex-meta">
                      {t('verificationMethod')}: {wallet.verificationMethod}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="alex-banner" role="status">
              <p className="alex-title-sm">{t('connectUnavailableTitle')}</p>
              <p className="alex-muted">{t('connectUnavailableBody')}</p>
            </div>
          </DomainStateView>
        )}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('withdrawalsTitle')}</h2>
        {withdrawals.isError || withdrawals.data === undefined ? (
          <DomainStateView state="ERROR" onRetry={() => void withdrawals.refetch()} />
        ) : withdrawals.data.withdrawals.length === 0 ? (
          <DomainStateView state="EMPTY" emptyTitle={t('withdrawalsEmpty')} />
        ) : (
          <ul className="alex-list">
            {withdrawals.data.withdrawals.map((item) => (
              <li key={item.id} className="alex-stack-sm">
                <p className="alex-title-sm">
                  {t('withdrawalState')}: {item.state}
                </p>
                <p className="alex-muted">
                  {t('withdrawalNet')}:{' '}
                  {isAtomicAmountString(item.netAmountAtomic)
                    ? formatAtomicAmount(item.netAmountAtomic)
                    : '—'}{' '}
                  <span className="alex-meta">{common('baseUnits')}</span>
                </p>
                <p className="alex-meta">
                  {t('withdrawalFee')}:{' '}
                  {isAtomicAmountString(item.feeAmountAtomic)
                    ? formatAtomicAmount(item.feeAmountAtomic)
                    : '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
