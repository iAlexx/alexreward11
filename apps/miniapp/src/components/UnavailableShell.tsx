'use client';

import { useTranslations } from 'next-intl';

type ShellKind = 'activity' | 'notifications';

/**
 * Honest unavailable shell — no mocked rows, unread counts, or invented inbox history.
 */
export function UnavailableShell({ kind }: { readonly kind: ShellKind }) {
  const t = useTranslations(kind);

  return (
    <div className="alex-stack lootra-unavailable-shell">
      <h1 className="alex-title">{t('title')}</h1>
      <div className="alex-card lootra-unavailable-card" role="status">
        <p className="alex-badge">{t('state')}</p>
        <p className="alex-muted">{t('body')}</p>
      </div>
    </div>
  );
}
