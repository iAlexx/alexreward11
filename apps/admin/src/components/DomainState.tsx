'use client';

import type { ReactNode } from 'react';

import type { AdminUiState } from '../lib/admin-api/types';
import { strings } from '../lib/strings';

export function DomainStateView({
  state,
  reasonCode,
  onRetry,
  children,
  emptyTitle,
  emptyBody,
  unavailableTitle,
  unavailableBody,
}: {
  readonly state: AdminUiState;
  readonly reasonCode?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly children?: ReactNode;
  readonly emptyTitle?: string | undefined;
  readonly emptyBody?: string | undefined;
  readonly unavailableTitle?: string | undefined;
  readonly unavailableBody?: string | undefined;
}) {
  if (state === 'LOADING') {
    return (
      <div className="admin-state" role="status" aria-live="polite" aria-label={strings.loading}>
        <p className="admin-muted">{strings.loading}</p>
      </div>
    );
  }

  if (state === 'ERROR') {
    return (
      <div className="admin-state" role="alert">
        <p>{strings.error}</p>
        {reasonCode !== undefined && reasonCode !== null ? (
          <p className="admin-meta">
            {strings.reasonCode}: {reasonCode}
          </p>
        ) : null}
        {onRetry !== undefined ? (
          <button type="button" className="admin-button admin-button--ghost" onClick={onRetry}>
            {strings.retry}
          </button>
        ) : null}
      </div>
    );
  }

  if (state === 'EMPTY') {
    return (
      <div className="admin-state" role="status">
        <p className="admin-title-sm">{emptyTitle ?? strings.empty}</p>
        {emptyBody !== undefined ? <p className="admin-muted">{emptyBody}</p> : null}
      </div>
    );
  }

  if (state === 'UNAVAILABLE') {
    return (
      <div className="admin-state" role="status">
        <p className="admin-title-sm">{unavailableTitle ?? strings.unavailable}</p>
        {unavailableBody !== undefined ? <p className="admin-muted">{unavailableBody}</p> : null}
        {reasonCode !== undefined && reasonCode !== null ? (
          <p className="admin-meta">
            {strings.reasonCode}: {reasonCode}
          </p>
        ) : null}
        {onRetry !== undefined && reasonCode !== 'ENGINE_NOT_ENABLED' ? (
          <button type="button" className="admin-button admin-button--ghost" onClick={onRetry}>
            {strings.retry}
          </button>
        ) : null}
      </div>
    );
  }

  if (state === 'DEGRADED') {
    return (
      <div className="admin-stack">
        <p className="admin-banner admin-banner--warn" role="status">
          {strings.degraded}
        </p>
        {children}
      </div>
    );
  }

  return <>{children}</>;
}
