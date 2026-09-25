'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Notification Campaigns"
      description="Notification campaign foundation."
      queryKey="admin-notification-campaigns"
      fetcher={(api, query) => api.getNotificationCampaigns(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'name', header: 'Name', field: 'name' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'scheduledAt', header: 'Scheduled', field: 'scheduledAt' },
      ]}
    />
  );
}
