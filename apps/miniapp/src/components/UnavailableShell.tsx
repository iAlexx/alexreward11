'use client';

import { useTranslations } from 'next-intl';

/**
 * Honest unavailable shell — no mocked rows, unread counts, or invented inbox history.
 */
export function UnavailableShell({
  kind,
}: {
  readonly kind: 'activity' | 'notifications';
}) {
  const t = useTranslations(kind);

  return (
    <div className="alex-stack lootra-unavailable-shell">
      <h1 className="alex-title">{t('title')}</h1>
      <section className="lootra-profile-card lootra-unavailable-card" role="status">
        <p className="lootra-unavailable-state">{t('state')}</p>
        <p className="alex-muted">{t('body')}</p>
      </section>
    </div>
  );
}
