'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Mission Admin"
      description="Mission administration foundation."
      queryKey="admin-missions"
      fetcher={(api, query) => api.getMissions(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'code', header: 'Code', field: 'code' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'title', header: 'Title', field: 'title' },
      ]}
    />
  );
}
