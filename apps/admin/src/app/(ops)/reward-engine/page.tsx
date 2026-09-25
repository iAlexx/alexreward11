'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Reward Engine"
      description="Versioned reward rule configurations."
      queryKey="admin-reward-engine"
      fetcher={(api, query) => api.getRewardEngine(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'country', header: 'Country group', field: 'countryGroup' },
        { id: 'enabled', header: 'Enabled', field: 'enabled' },
        { id: 'effectiveAt', header: 'Effective', field: 'effectiveAt' },
      ]}
    />
  );
}
