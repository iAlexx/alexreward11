'use client';

import { useTranslations } from 'next-intl';

/** Partial LOOTRA Wallet loading skeletons — domains load independently. */
export function WalletHeroSkeleton() {
  const a11y = useTranslations('a11y');
  return (
    <div
      className="lootra-wallet-skel lootra-wallet-skel--hero"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-line lootra-skel-greeting" />
      <div className="lootra-skel lootra-skel-hero" />
    </div>
  );
}

export function WalletBalancesSkeleton() {
  const a11y = useTranslations('a11y');
  return (
    <div
      className="lootra-wallet-skel"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-card" />
    </div>
  );
}

export function WalletCardSkeleton() {
  const a11y = useTranslations('a11y');
  return (
    <div
      className="lootra-wallet-skel"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-card" />
    </div>
  );
}

export function WalletHistorySkeleton() {
  const a11y = useTranslations('a11y');
  return (
    <div
      className="lootra-wallet-skel"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
    </div>
  );
}
