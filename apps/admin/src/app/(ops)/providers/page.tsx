'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Providers"
      description="Approved advertising providers and adapter metadata."
      queryKey="admin-providers"
      fetcher={(api, query) => api.getProviders(query)}
      columns={[
        { id: 'code', header: 'Code', field: 'code' },
        { id: 'name', header: 'Name', field: 'displayName' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'monetary', header: 'Monetary', field: 'productionMonetaryStatus' },
      ]}
    />
  );
}
