'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge } from '../StateBadge';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/**
 * Economics — Spec §156M typed metrics.
 * Never label confirmed withdrawal principal as settled margin/profit.
 */
export function EconomicsPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'economics'],
    (api) => api.getEconomics(),
  );

  const metrics = data?.metrics ?? [];

  return (
    <div className="admin-stack">
      <PageHeader
        title="Economics"
        description={strings.estimatedNotProfit}
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <div className="admin-metric-grid">
            {metrics.map((metric) => (
              <div className="admin-metric" key={metric.metric}>
                <p className="admin-meta">
                  <StateBadge
                    state={metric.basis}
                    tone={metric.status === 'READY' ? 'success' : 'warning'}
                  />{' '}
                  {metric.metric}
                </p>
                <p className="admin-metric__value admin-mono">
                  {metric.status === 'READY'
                    ? formatOptionalAtomic(metric.amountAtomic)
                    : 'UNAVAILABLE'}
                </p>
                {metric.reasonCode !== undefined ? (
                  <p className="admin-meta">{metric.reasonCode}</p>
                ) : null}
                {metric.metric === 'CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL' ? (
                  <p className="admin-meta">
                    Operational payout principal only — not settled margin or revenue.
                  </p>
                ) : null}
                {metric.metric === 'NET_CONTRIBUTION_MARGIN_ESTIMATE' ? (
                  <p className="admin-meta">{strings.estimatedNotProfit}</p>
                ) : null}
              </div>
            ))}
            {data.note !== undefined ? <p className="admin-meta">{data.note}</p> : null}
          </div>
        ) : null}
      </DomainStateView>
    </div>
  );
}
