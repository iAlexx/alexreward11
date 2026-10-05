'use client';

import type { HomeMembershipBriefData } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

import { AppLink } from './AppLink';

export function HomeMembershipBrief({
  status,
  data,
}: {
  readonly status: 'READY' | 'EMPTY' | 'UNAVAILABLE';
  readonly data: HomeMembershipBriefData | null;
}) {
  const t = useTranslations('home');

  if (status !== 'READY' || data === null) {
    return null;
  }

  if (data.isFounder) {
    return (
      <section className="lootra-home-card lootra-membership" aria-labelledby="lootra-membership-title">
        <h2 id="lootra-membership-title" className="alex-title-sm">
          {t('membership')}
        </h2>
        <p className="lootra-founder-badge">{t('founderBadge')}</p>
        {data.founderNumber !== null ? (
          <p className="lootra-founder-number">
            {t('founderNumber', { number: data.founderNumber })}
          </p>
        ) : null}
        <AppLink href="/profile/founder" className="lootra-btn lootra-btn--ghost">
          {t('openFounder')}
        </AppLink>
      </section>
    );
  }

  return (
    <section className="lootra-home-card lootra-membership" aria-labelledby="lootra-membership-title">
      <h2 id="lootra-membership-title" className="alex-title-sm">
        {t('membership')}
      </h2>
      <p className="alex-muted">{t('lootraMember')}</p>
    </section>
  );
}
