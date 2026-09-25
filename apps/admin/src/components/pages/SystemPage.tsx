'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

export function SystemPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'system'],
    (api) => api.getSystemHealth(),
  );

  const components = data?.components ?? [];

  return (
    <div className="admin-stack">
      <PageHeader title="System" description="Component health and operational readiness." />
      <div className="admin-banner admin-banner--warn" role="status">
        <p>{strings.payoutPauseWarning}</p>
        <p className="admin-meta">{strings.payoutPauseCeremony}</p>
      </div>
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <ul className="admin-stack">
          {components.map((item) => (
            <li key={item.component} className="admin-panel">
              <div className="admin-panel__head">
                <h2 className="admin-title-sm">{item.component}</h2>
                {item.status === null ? (
                  <span className="admin-meta">—</span>
                ) : (
                  <StateBadge state={item.status} tone={toneForState(item.status)} />
                )}
              </div>
              {item.detail !== null ? <p className="admin-muted">{item.detail}</p> : null}
            </li>
          ))}
        </ul>
        {components.length === 0 ? <p className="admin-muted">{strings.empty}</p> : null}
      </DomainStateView>
    </div>
  );
}
