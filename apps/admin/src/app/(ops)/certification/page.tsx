'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Certification"
      description="Provider certification harness results."
      queryKey="admin-certification"
      fetcher={(api, query) => api.getCertification(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'provider', header: 'Provider', field: 'providerCode' },
        { id: 'suite', header: 'Suite', field: 'suiteCode' },
        { id: 'result', header: 'Result', field: 'result' },
        { id: 'ranAt', header: 'Ran at', field: 'ranAt' },
      ]}
    />
  );
}
