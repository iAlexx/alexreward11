'use client';

import { TonConnectUIProvider } from '@tonconnect/ui-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { tonConnectManifestUrl } from '../lib/env';
import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { MoneyAmount } from './MoneyAmount';
import { WalletTonConnectPanel } from './WalletTonConnectPanel';
import { WalletWithdrawalQuote } from './WalletWithdrawalQuote';

export function WalletScreen() {
  const t = useTranslations('wallet');
  const home = useTranslations('home');
  const common = useTranslations('common');
  const { api } = useAuth();
  const manifestUrl = tonConnectManifestUrl();

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
            <MoneyAmount bucket={balances.data.available} label={home('balanceAvailable')} />
            <MoneyAmount bucket={balances.data.pending} label={home('balancePending')} />
            <MoneyAmount bucket={balances.data.reserved} label={home('balanceReserved')} />
            <p className="alex-meta">{common('baseUnitsNote')}</p>
          </div>
        )}
      </section>

      <section className="alex-card">
        <h2 className="alex-title-sm">{t('walletsTitle')}</h2>
        {wallets.isError || wallets.data === undefined ? (
          <DomainStateView state="ERROR" onRetry={() => void wallets.refetch()} />
        ) : (
          <div className="alex-stack-sm">
            <p className="alex-meta">
              {t('network')}: {wallets.data.acceptedNetworkCode}
            </p>
            {wallets.data.withdrawalCooldownUntil !== null ? (
              <p className="alex-banner alex-banner--warn" role="status">
                {t('cooldownUntil', { time: wallets.data.withdrawalCooldownUntil })}
              </p>
            ) : null}
            {wallets.data.wallets.length === 0 ? (
              <DomainStateView
                state="EMPTY"
                emptyTitle={t('noWalletsTitle')}
                emptyBody={t('noWalletsBody')}
              />
            ) : (
              <ul className="alex-list">
                {wallets.data.wallets.map((wallet) => (
                  <li key={wallet.id} className="alex-stack-sm">
                    <p className="alex-title-sm">{wallet.friendlyAddress}</p>
                    <p className="alex-muted">
                      {wallet.isPrimary || wallet.id === wallets.data.primaryWalletId
                        ? t('primary')
                        : null}
                      {wallet.isPrimary || wallet.id === wallets.data.primaryWalletId
                        ? ' · '
                        : null}
                      {wallet.verified ? t('verified') : t('notVerified')}
                      {wallet.disabledAt !== null ? ` · ${t('disabled')}` : null}
                    </p>
                    {wallet.verifiedAt !== null ? (
                      <p className="alex-meta">{t('verifiedAt', { time: wallet.verifiedAt })}</p>
                    ) : null}
                    {wallet.verificationMethod !== null ? (
                      <p className="alex-meta">
                        {t('verificationMethod')}: {wallet.verificationMethod}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {manifestUrl === null ? (
              <div className="alex-banner" role="status">
                <p className="alex-title-sm">{t('connectUnavailableTitle')}</p>
                <p className="alex-muted">{t('connectUnavailableBody')}</p>
              </div>
            ) : (
              <TonConnectUIProvider manifestUrl={manifestUrl} restoreConnection={false}>
                <WalletTonConnectPanel />
              </TonConnectUIProvider>
            )}
          </div>
        )}
      </section>

      <WalletWithdrawalQuote />

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
                <p className="alex-meta">
                  {t('withdrawalRequested')}:{' '}
                  {isAtomicAmountString(item.requestedAmountAtomic)
                    ? formatAtomicAmount(item.requestedAmountAtomic)
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
