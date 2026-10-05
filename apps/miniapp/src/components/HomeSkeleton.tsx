'use client';

import { useTranslations } from 'next-intl';

/** LOOTRA Home loading skeleton — no fabricated financial values. */
export function HomeSkeleton() {
  const a11y = useTranslations('a11y');

  return (
    <div
      className="lootra-home-skeleton alex-stack"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-line lootra-skel-greeting" />
      <div className="lootra-skel lootra-skel-hero" />
      <div className="lootra-skel lootra-skel-card" />
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
    </div>
  );
}
