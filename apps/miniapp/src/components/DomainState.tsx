'use client';

import type { DomainReasonCode, ServerDomainAvailability } from '@alex-rewards/contracts';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export type UiDomainState = ServerDomainAvailability | 'LOADING' | 'ERROR' | 'DEGRADED';

export function DomainStateView({
  state,
  reasonCode = null,
  onRetry,
  children,
  emptyTitle,
  emptyBody,
  unavailableTitle,
  unavailableBody,
}: {
  readonly state: UiDomainState;
  readonly reasonCode?: DomainReasonCode | string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly children?: ReactNode;
  readonly emptyTitle?: string | undefined;
  readonly emptyBody?: string | undefined;
  readonly unavailableTitle?: string | undefined;
  readonly unavailableBody?: string | undefined;
}) {
  const t = useTranslations('common');
  const a11y = useTranslations('a11y');

  if (state === 'LOADING') {
    return (
      <div className="alex-state" role="status" aria-live="polite" aria-label={a11y('loading')}>
        <p className="alex-muted">{t('loading')}</p>
      </div>
    );
  }

  if (state === 'ERROR') {
    return (
      <div className="alex-state" role="alert">
        <p>{t('error')}</p>
        {onRetry !== undefined ? (
          <button type="button" className="alex-button alex-button--ghost" onClick={onRetry}>
            {t('retry')}
          </button>
        ) : null}
      </div>
    );
  }

  if (state === 'EMPTY') {
    return (
      <div className="alex-state" role="status">
        <p className="alex-title-sm">{emptyTitle ?? t('empty')}</p>
        {emptyBody !== undefined ? <p className="alex-muted">{emptyBody}</p> : null}
      </div>
    );
  }

  if (state === 'UNAVAILABLE') {
    const engine = reasonCode === 'ENGINE_NOT_ENABLED';
    return (
      <div className="alex-state" role="status">
        <p className="alex-title-sm">
          {unavailableTitle ?? (engine ? t('engineNotEnabled') : t('unavailable'))}
        </p>
        {unavailableBody !== undefined ? <p className="alex-muted">{unavailableBody}</p> : null}
        {reasonCode !== undefined && reasonCode !== null ? (
          <p className="alex-meta">
            {t('reasonCodes')}: {reasonCode}
          </p>
        ) : null}
        {onRetry !== undefined && reasonCode !== 'ENGINE_NOT_ENABLED' ? (
          <button type="button" className="alex-button alex-button--ghost" onClick={onRetry}>
            {t('retry')}
          </button>
        ) : null}
      </div>
    );
  }

  if (state === 'DEGRADED') {
    return (
      <div className="alex-stack">
        <p className="alex-banner alex-banner--warn" role="status">
          {t('degraded')}
        </p>
        {children}
      </div>
    );
  }

  return <>{children}</>;
}
