'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Notifications"
      description="Outbound notification history."
      queryKey="admin-notifications"
      fetcher={(api, query) => api.getNotifications(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'channel', header: 'Channel', field: 'channel' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'createdAt', header: 'Created', field: 'createdAt' },
      ]}
    />
  );
}
