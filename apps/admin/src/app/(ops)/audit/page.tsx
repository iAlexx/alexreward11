'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Audit"
      description="Immutable Owner action audit trail."
      queryKey="admin-audit"
      fetcher={(api, query) => api.getAudit(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'action', header: 'Action', field: 'actionCode' },
        { id: 'actor', header: 'Actor', field: 'adminUserId' },
        { id: 'createdAt', header: 'Created', field: 'createdAt' },
      ]}
    />
  );
}
