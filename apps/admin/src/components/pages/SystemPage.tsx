'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge } from '../StateBadge';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

function toneForHealth(state: string | null): 'neutral' | 'success' | 'warning' | 'error' | 'info' {
  if (state === null) return 'neutral';
  const normalized = state.toUpperCase();
  if (normalized === 'OK' || normalized === 'INFO') return 'success';
  if (
    normalized === 'DEGRADED' ||
    normalized === 'OWNER_POLICY_REQUIRED' ||
    normalized === 'WARN' ||
    normalized === 'UNKNOWN'
  ) {
    return 'warning';
  }
  if (normalized === 'UNAVAILABLE' || normalized === 'DANGER') return 'error';
  return 'neutral';
}

/**
 * Phase 18 System / Business Health — read-only.
 * No balance editing, ledger mutation, payout approve shortcuts, or unpause controls.
 */
export function SystemPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'system'],
    (api) => api.getSystemHealth(),
  );

  const systemComponents = data?.systemComponents ?? [];
  const legacyComponents = data?.components ?? [];
  const alerts = data?.alerts ?? [];
  const pause = data?.payoutDispatchPause ?? null;

  const displayComponents =
    systemComponents.length > 0
      ? systemComponents.map((item) => ({
          key: item.component,
          label: item.component,
          status: item.state,
          detail: item.reasonCode,
        }))
      : legacyComponents.map((item) => ({
          key: item.component,
          label: item.component,
          status: item.status,
          detail: item.detail,
        }));

  return (
    <div className="admin-stack">
      <PageHeader
        title="System"
        description="Read-only system and business health. Observations only — not financial truth."
      />
      <div className="admin-banner admin-banner--warn" role="status">
        <p>{strings.payoutPauseWarning}</p>
        <p className="admin-meta">{strings.payoutPauseCeremony}</p>
        {pause !== null ? (
          <p className="admin-meta">
            Authoritative pause source: {pause.authoritativeSource} / {pause.flagKey} —{' '}
            {pause.enabled === null
              ? 'not configured'
              : pause.enabled
                ? 'PAUSED'
                : 'not paused'}{' '}
            (autoUnpause={String(pause.autoUnpause)})
          </p>
        ) : null}
      </div>

      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <section className="admin-stack" aria-label="System components">
          <h2 className="admin-title-sm">System</h2>
          <ul className="admin-stack">
            {displayComponents.map((item) => (
              <li key={item.key} className="admin-panel">
                <div className="admin-panel__head">
                  <h3 className="admin-title-sm">{item.label}</h3>
                  {item.status === null ? (
                    <span className="admin-meta">—</span>
                  ) : (
                    <StateBadge state={item.status} tone={toneForHealth(item.status)} />
                  )}
                </div>
                {item.detail !== null && item.detail !== undefined ? (
                  <p className="admin-muted">{item.detail}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {displayComponents.length === 0 ? <p className="admin-muted">{strings.empty}</p> : null}
        </section>

        <section className="admin-stack" aria-label="Business alerts">
          <h2 className="admin-title-sm">Business alerts</h2>
          <ul className="admin-stack">
            {alerts.map((alert) => (
              <li key={`${alert.alertClass}-${alert.reasonCode}`} className="admin-panel">
                <div className="admin-panel__head">
                  <h3 className="admin-title-sm">{alert.alertClass}</h3>
                  <StateBadge state={alert.severity} tone={toneForHealth(alert.severity)} />
                </div>
                <p className="admin-muted">{alert.reasonCode}</p>
                <p className="admin-meta">
                  financialAuthority={String(alert.financialAuthority)} · autoUnpause=
                  {String(alert.autoUnpause)}
                </p>
              </li>
            ))}
          </ul>
          {alerts.length === 0 ? (
            <p className="admin-muted">No alert observations in this snapshot.</p>
          ) : null}
        </section>
      </DomainStateView>
    </div>
  );
}
