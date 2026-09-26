'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Provider Contracts"
      description="Provider commercial/contract versions."
      queryKey="admin-provider-contracts"
      fetcher={(api, query) => api.getProviderContracts(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'version', header: 'Version', field: 'version' },
        { id: 'effectiveAt', header: 'Effective', field: 'effectiveAt' },
      ]}
    />
  );
}
