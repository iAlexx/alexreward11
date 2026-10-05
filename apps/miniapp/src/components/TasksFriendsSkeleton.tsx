'use client';

import { useTranslations } from 'next-intl';

/** LOOTRA Tasks loading skeleton — no fabricated mission titles or counts. */
export function TasksSkeleton() {
  const a11y = useTranslations('a11y');

  return (
    <div
      className="lootra-tasks-skeleton alex-stack"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-line lootra-skel-greeting" />
      <div className="lootra-skel lootra-skel-hero" />
      <div className="lootra-skel lootra-skel-card" />
    </div>
  );
}

/** LOOTRA Friends loading skeleton — no fabricated referral stats. */
export function FriendsSkeleton() {
  const a11y = useTranslations('a11y');

  return (
    <div
      className="lootra-friends-skeleton alex-stack"
      role="status"
      aria-live="polite"
      aria-label={a11y('loading')}
    >
      <div className="lootra-skel lootra-skel-line lootra-skel-greeting" />
      <div className="lootra-skel lootra-skel-hero" />
      <div className="lootra-skel lootra-skel-card lootra-skel-card--sm" />
    </div>
  );
}
