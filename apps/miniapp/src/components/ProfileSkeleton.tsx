'use client';

import { useTranslations } from 'next-intl';

/** LOOTRA Profile loading skeleton — no fabricated identity or settings. */
export function ProfileSkeleton() {
  const a11y = useTranslations('a11y');

  return (
    <div
      className="lootra-profile-skeleton alex-stack"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-line lootra-skel-greeting" />
      <div className="lootra-skel lootra-skel-card" />
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
    </div>
  );
}
