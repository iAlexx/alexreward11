'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Capabilities"
      description="Provider capability manifests."
      queryKey="admin-capabilities"
      fetcher={(api, query) => api.getCapabilities(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'capability', header: 'Capability', field: 'capabilityCode' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
