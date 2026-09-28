'use client';

import type { BalanceBucketDto, UserBalancesResponse } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import type { HomeWalletCta } from '../lib/home/home-wallet-cta';
import { AppLink } from './AppLink';

function HeroBucket({
  bucket,
  label,
  dominant = false,
}: {
  readonly bucket: BalanceBucketDto;
  readonly label: string;
  readonly dominant?: boolean;
}) {
  const t = useTranslations('home');
  const common = useTranslations('common');

  if (bucket.state === 'UNAVAILABLE') {
    return (
      <div className={dominant ? 'lootra-hero-available' : 'lootra-hero-meta'}>
        <span className="lootra-hero-label">{label}</span>
        <span className="lootra-hero-unavailable">{t('balanceUnavailable')}</span>
      </div>
    );
  }

  const amount = isAtomicAmountString(bucket.amountAtomic)
    ? formatAtomicAmountGrouped(bucket.amountAtomic)
    : '—';

  return (
    <div className={dominant ? 'lootra-hero-available' : 'lootra-hero-meta'}>
      <span className="lootra-hero-label">{label}</span>
      <span className={dominant ? 'lootra-hero-amount' : 'lootra-hero-meta-value'}>{amount}</span>
      <span className="lootra-hero-unit">
        {common('baseUnits')} · {bucket.assetSymbol}
      </span>
    </div>
  );
}

export function HomeBalanceHero({
  balances,
  balancesStatus,
  cta,
  onRetry,
}: {
  readonly balances: UserBalancesResponse | null;
  readonly balancesStatus: 'READY' | 'EMPTY' | 'UNAVAILABLE';
  readonly cta: HomeWalletCta;
  readonly onRetry?: (() => void) | undefined;
}) {
  const t = useTranslations('home');

  const ctaLabel =
    cta.kind === 'connect'
      ? t('ctaConnectWallet')
      : cta.kind === 'withdraw'
        ? t('ctaWithdraw')
        : t('ctaOpenWallet');

  return (
    <section className="lootra-balance-hero" aria-labelledby="lootra-balance-hero-title">
      <span className="lootra-hero-orbit" aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand accent */}
      <img
        className="lootra-hero-accent"
        src="/brand/lootra/l-accent.png"
        alt=""
        width={160}
        height={160}
        aria-hidden="true"
      />
      <div className="lootra-hero-body">
        <h2 id="lootra-balance-hero-title" className="lootra-hero-eyebrow">
          {t('balancesTitle')}
        </h2>

        {balancesStatus === 'UNAVAILABLE' || balances === null ? (
          <div className="lootra-hero-unavailable-block" role="status">
            <p className="lootra-hero-unavailable">{t('balancesUnavailable')}</p>
            {onRetry !== undefined ? (
              <button type="button" className="lootra-btn lootra-btn--ghost" onClick={onRetry}>
                {t('retryBalances')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <HeroBucket bucket={balances.available} label={t('balanceAvailable')} dominant />
            <div className="lootra-hero-secondary">
              <HeroBucket bucket={balances.pending} label={t('balancePending')} />
              <HeroBucket bucket={balances.reserved} label={t('balanceReserved')} />
            </div>
          </>
        )}

        <AppLink href={cta.href} className="lootra-btn lootra-btn--primary lootra-hero-cta">
          {ctaLabel}
        </AppLink>
      </div>
    </section>
  );
}
