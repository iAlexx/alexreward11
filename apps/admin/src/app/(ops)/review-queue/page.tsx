'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Review Queue"
      description="Unified queue for withdrawal, fraud, provider, invalid-traffic, referral, Founder-claim, and support escalations."
      queryKey="admin-review-queue"
      fetcher={(api, query) => api.getReviewQueue(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'family', header: 'Family', field: 'family' },
        { id: 'status', header: 'Status', field: 'status' },
        { id: 'priority', header: 'Priority', field: 'priority' },
        { id: 'createdAt', header: 'Created', field: 'createdAt' },
      ]}
    />
  );
}
