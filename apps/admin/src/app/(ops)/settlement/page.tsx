'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Settlement"
      description="Provider settlement and reconciliation cases."
      queryKey="admin-settlement"
      fetcher={(api, query) => api.getSettlement(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'period', header: 'Period', field: 'periodId' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
