'use client';

import type { HomeAnnouncementData } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';

export function HomeAnnouncementCard({
  status,
  data,
}: {
  readonly status: 'READY' | 'EMPTY' | 'UNAVAILABLE';
  readonly data: HomeAnnouncementData | null;
}) {
  const t = useTranslations('home');

  if (status === 'EMPTY' || status === 'UNAVAILABLE' || data === null) {
    return null;
  }

  return (
    <section className="lootra-home-card" aria-labelledby="lootra-announcement-title">
      <h2 id="lootra-announcement-title" className="alex-title-sm">
        {t('announcement')}
      </h2>
      <p className="lootra-announcement-title">{data.title ?? data.typeCode}</p>
      <p className="alex-meta">
        {data.typeCode} · {data.createdAt}
      </p>
    </section>
  );
}
