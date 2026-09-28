'use client';

import { TonConnectUIProvider } from '@tonconnect/ui-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { UserWalletDto, WalletSummaryResponse } from '@alex-rewards/contracts';

import { AppLink } from './AppLink';
import { DomainStateView } from './DomainState';
import { MoneyAmount } from './MoneyAmount';
import {
  WalletBalancesSkeleton,
  WalletCardSkeleton,
  WalletHeroSkeleton,
  WalletHistorySkeleton,
} from './WalletSkeleton';
import { WalletTonConnectPanel } from './WalletTonConnectPanel';
import { WalletWithdrawalQuote } from './WalletWithdrawalQuote';
import { tonConnectManifestUrl } from '../lib/env';
import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { canEnterWithdrawalQuote } from '../lib/wallet/withdrawal-eligibility';
import {
  isWithdrawalCooldownActive,
  shortenFriendlyAddress,
} from '../lib/wallet/wallet-format';
import {
  isKnownWithdrawalState,
  matchesHistoryFilter,
  type HistoryFilter,
  withdrawalStateMessageKey,
} from '../lib/wallet/withdrawal-states';
import { useAuth } from '../providers/AuthProvider';

function networkLabel(
  code: string,
  t: ReturnType<typeof useTranslations<'wallet'>>,
): string {
  if (code.includes('TESTNET')) return `${t('networkTestnet')} · ${code}`;
  if (code.includes('MAINNET')) return `${t('networkMainnet')} · ${code}`;
  return code;
}

function WalletHero({
  acceptedNetworkCode,
}: {
  readonly acceptedNetworkCode: string | null;
}) {
  const t = useTranslations('wallet');

  return (
    <header className="lootra-wallet-hero">
      <div className="lootra-wallet-hero__copy">
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-muted">{t('heroSubtitle')}</p>
        {acceptedNetworkCode !== null ? (
          <p className="lootra-wallet-network" role="status">
            {t('network')}: {networkLabel(acceptedNetworkCode, t)}
          </p>
        ) : null}
      </div>
      <div className="lootra-wallet-hero__visual" aria-hidden="true">
        <span className="lootra-wallet-hero__orbit" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-wallet-hero__art"
          src="/brand/lootra/wallet-hero.png"
          alt=""
          width={220}
          height={220}
        />
      </div>
    </header>
  );
}

function WalletCard({
  wallet,
  primaryWalletId,
}: {
  readonly wallet: UserWalletDto;
  readonly primaryWalletId: string | null;
}) {
  const t = useTranslations('wallet');
  const isPrimary = wallet.isPrimary || wallet.id === primaryWalletId;
  const short = shortenFriendlyAddress(wallet.friendlyAddress);

  return (
    <li className="lootra-wallet-item">
      <p className="lootra-wallet-address" title={wallet.friendlyAddress}>
        <span className="lootra-wallet-address__visual" aria-hidden="true">
          {short}
        </span>
        <span className="lootra-wallet-address__sr">{wallet.friendlyAddress}</span>
      </p>
      {wallet.walletName !== null && wallet.walletName !== undefined && wallet.walletName !== '' ? (
        <p className="alex-muted">{wallet.walletName}</p>
      ) : null}
      <p className="alex-muted">
        {isPrimary ? t('primary') : null}
        {isPrimary ? ' · ' : null}
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
  );
}

function WalletsSection({
  wallets,
  isLoading,
  isError,
  onRetry,
}: {
  readonly wallets: WalletSummaryResponse | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('wallet');
  const manifestUrl = tonConnectManifestUrl();

  if (isLoading) return <WalletCardSkeleton />;
  if (isError || wallets === undefined) {
    return <DomainStateView state="ERROR" onRetry={onRetry} />;
  }

  const cooldownActive = isWithdrawalCooldownActive(wallets.withdrawalCooldownUntil);

  return (
    <section className="lootra-wallet-card" aria-labelledby="lootra-wallets-title">
      <h2 id="lootra-wallets-title" className="alex-title-sm">
        {t('walletsTitle')}
      </h2>
      <p className="alex-meta">
        {t('network')}: {networkLabel(wallets.acceptedNetworkCode, t)}
      </p>

      {cooldownActive && wallets.withdrawalCooldownUntil !== null ? (
        <p className="alex-banner alex-banner--warn" role="status">
          {t('cooldownWarning')}
          <br />
          {t('cooldownUntil', { time: wallets.withdrawalCooldownUntil })}
        </p>
      ) : null}

      {wallets.wallets.length === 0 ? (
        <DomainStateView
          state="EMPTY"
          emptyTitle={t('noWalletsTitle')}
          emptyBody={t('noWalletsBody')}
        />
      ) : (
        <ul className="lootra-wallet-list">
          {wallets.wallets.map((wallet) => (
            <WalletCard
              key={wallet.id}
              wallet={wallet}
              primaryWalletId={wallets.primaryWalletId}
            />
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
    </section>
  );
}

function WithdrawalHistorySection() {
  const t = useTranslations('wallet');
  const common = useTranslations('common');
  const { api } = useAuth();
  const [filter, setFilter] = useState<HistoryFilter>('all');

  const withdrawals = useQuery({
    queryKey: queryKeys.withdrawals,
    queryFn: () => api.getWithdrawals(),
  });

  if (withdrawals.isLoading) return <WalletHistorySkeleton />;
  if (withdrawals.isError || withdrawals.data === undefined) {
    return (
      <section className="lootra-wallet-card" aria-labelledby="lootra-history-title">
        <h2 id="lootra-history-title" className="alex-title-sm">
          {t('withdrawalsTitle')}
        </h2>
        <DomainStateView state="ERROR" onRetry={() => void withdrawals.refetch()} />
      </section>
    );
  }

  const items = withdrawals.data.withdrawals.filter((item) =>
    matchesHistoryFilter(item.state, filter),
  );

  return (
    <section className="lootra-wallet-card" aria-labelledby="lootra-history-title">
      <h2 id="lootra-history-title" className="alex-title-sm">
        {t('withdrawalsTitle')}
      </h2>

      <div className="lootra-history-filters" role="group" aria-label={t('historyFilter')}>
        {(
          [
            ['all', 'filterAll'],
            ['in_progress', 'filterInProgress'],
            ['attention', 'filterAttention'],
            ['final', 'filterFinal'],
          ] as const
        ).map(([value, key]) => (
          <button
            key={value}
            type="button"
            className={
              filter === value
                ? 'lootra-btn lootra-btn--ghost lootra-filter--active'
                : 'lootra-btn lootra-btn--ghost'
            }
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {t(key)}
          </button>
        ))}
      </div>

      {withdrawals.data.withdrawals.length === 0 ? (
        <DomainStateView state="EMPTY" emptyTitle={t('withdrawalsEmpty')} />
      ) : items.length === 0 ? (
        <p className="alex-muted">{t('historyFilterEmpty')}</p>
      ) : (
        <ul className="lootra-history-list">
          {items.map((item) => {
            const stateKey = withdrawalStateMessageKey(item.state);
            const stateLabel = isKnownWithdrawalState(item.state)
              ? t(stateKey as 'state_REQUESTED')
              : t('stateUnknown', { state: item.state });
            return (
              <li key={item.id} className="lootra-history-item">
                <AppLink
                  href={`/wallet/withdrawals/${encodeURIComponent(item.id)}`}
                  className="lootra-history-link"
                >
                  <span className="lootra-history-id">{item.publicId}</span>
                  <span className="alex-muted">{stateLabel}</span>
                  <span className="lootra-history-net">
                    {isAtomicAmountString(item.netAmountAtomic)
                      ? formatAtomicAmountGrouped(item.netAmountAtomic)
                      : '—'}{' '}
                    <span className="alex-meta">{common('baseUnits')}</span>
                  </span>
                </AppLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function WalletScreen() {
  const t = useTranslations('wallet');
  const home = useTranslations('home');
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

  const eligible = canEnterWithdrawalQuote(wallets.data);
  const networkCode =
    wallets.data !== undefined ? wallets.data.acceptedNetworkCode : null;

  return (
    <div className="alex-stack lootra-wallet">
      {wallets.isLoading && balances.isLoading ? (
        <WalletHeroSkeleton />
      ) : (
        <WalletHero acceptedNetworkCode={networkCode} />
      )}

      <section className="lootra-wallet-card" aria-labelledby="lootra-balances-title">
        <h2 id="lootra-balances-title" className="alex-title-sm">
          {t('balancesTitle')}
        </h2>
        {balances.isLoading ? (
          <WalletBalancesSkeleton />
        ) : balances.isError || balances.data === undefined ? (
          <DomainStateView state="ERROR" onRetry={() => void balances.refetch()} />
        ) : (
          <div className="alex-stack-sm lootra-wallet-balances">
            <MoneyAmount bucket={balances.data.available} label={home('balanceAvailable')} />
            <MoneyAmount bucket={balances.data.pending} label={home('balancePending')} />
            <MoneyAmount bucket={balances.data.reserved} label={home('balanceReserved')} />
            <p className="alex-meta">{common('baseUnitsNote')}</p>
          </div>
        )}
      </section>

      <WalletsSection
        wallets={wallets.data}
        isLoading={wallets.isLoading}
        isError={wallets.isError}
        onRetry={() => void wallets.refetch()}
      />

      <WalletWithdrawalQuote eligible={eligible} />

      <WithdrawalHistorySection />
    </div>
  );
}
