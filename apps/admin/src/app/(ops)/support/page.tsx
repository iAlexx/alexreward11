'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Support"
      description="Support tickets and escalations."
      queryKey="admin-support"
      fetcher={(api, query) => api.getSupport(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'user', header: 'User', field: 'userId' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'subject', header: 'Subject', field: 'subject' },
      ]}
    />
  );
}
