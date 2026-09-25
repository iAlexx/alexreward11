'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Limits"
      description="Provider and platform limits. Changes require old/new diff, source, effective time, and impact preview."
      queryKey="admin-limits"
      fetcher={(api, query) => api.getLimits(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'code', header: 'Limit', field: 'limitCode' },
        { id: 'value', header: 'Value', field: 'value' },
        { id: 'effectiveAt', header: 'Effective', field: 'effectiveAt' },
      ]}
    />
  );
}
