'use client';

import { DomainStateView } from '../../../components/DomainState';
import { PageHeader } from '../../../components/PageHeader';
import { strings } from '../../../lib/strings';
import { useAdminDomainQuery } from '../../../lib/hooks/useAdminDomainQuery';

export default function Page() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'settings'],
    (api) => api.getSettings(),
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="Settings"
        description={`${strings.noBalanceEditor} Financial settings require audit and confirmation.`}
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <pre className="admin-panel admin-mono" style={{ overflow: 'auto' }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        ) : null}
      </DomainStateView>
    </div>
  );
}
