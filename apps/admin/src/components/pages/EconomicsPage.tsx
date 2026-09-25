'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge } from '../StateBadge';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/**
 * Economics — label ESTIMATED vs SETTLED distinctly.
 * Never call estimate "profit".
 */
export function EconomicsPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'economics'],
    (api) => api.getEconomics(),
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="Economics"
        description={strings.estimatedNotProfit}
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <div className="admin-metric-grid">
            <div className="admin-metric">
              <p className="admin-meta">
                <StateBadge state={strings.estimated} tone="warning" /> Margin
              </p>
              <p className="admin-metric__value admin-mono">
                {formatOptionalAtomic(data.estimatedMarginAtomic)}
              </p>
              <p className="admin-meta">{strings.estimatedNotProfit}</p>
            </div>
            <div className="admin-metric">
              <p className="admin-meta">
                <StateBadge state={strings.settled} tone="success" /> Margin
              </p>
              <p className="admin-metric__value admin-mono">
                {formatOptionalAtomic(data.settledMarginAtomic)}
              </p>
            </div>
            <div className="admin-metric">
              <p className="admin-meta">Pending receivables</p>
              <p className="admin-metric__value admin-mono">
                {formatOptionalAtomic(data.pendingReceivablesAtomic)}
              </p>
            </div>
            <div className="admin-metric">
              <p className="admin-meta">Fee revenue ({strings.settled})</p>
              <p className="admin-metric__value admin-mono">
                {formatOptionalAtomic(data.feeRevenueAtomic)}
              </p>
            </div>
          </div>
        ) : null}
      </DomainStateView>
    </div>
  );
}
