'use client';

import { DomainStateView } from '../../../components/DomainState';
import { PageHeader } from '../../../components/PageHeader';
import { formatOptionalAtomic } from '../../../lib/money/format';
import { useAdminDomainQuery } from '../../../lib/hooks/useAdminDomainQuery';

function readAtomicField(
  data: Record<string, unknown> | null,
  key: string,
): string | null {
  if (data === null) return null;
  const value = data[key];
  return typeof value === 'string' ? value : null;
}

export default function Page() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'exposure'],
    (api) => api.getExposure(),
  );

  const unsettled = readAtomicField(data, 'unsettledReceivableAtomic');
  const budget = readAtomicField(data, 'maxUnsettledExposureAtomic');

  return (
    <div className="admin-stack">
      <PageHeader
        title="Exposure"
        description="Economic exposure and budget controls. Missing values stay unavailable — never fabricated zeros."
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <div className="admin-metric-grid">
          <div className="admin-metric">
            <p className="admin-meta">Unsettled provider receivable</p>
            <p className="admin-metric__value admin-mono">{formatOptionalAtomic(unsettled)}</p>
          </div>
          <div className="admin-metric">
            <p className="admin-meta">Max unsettled exposure</p>
            <p className="admin-metric__value admin-mono">{formatOptionalAtomic(budget)}</p>
          </div>
        </div>
      </DomainStateView>
    </div>
  );
}
