'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Country Rules"
      description="Country/provider eligibility rules."
      queryKey="admin-country-rules"
      fetcher={(api, query) => api.getCountryRules(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'country', header: 'Country', field: 'countryCode' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
