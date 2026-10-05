'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Memberships/Founders"
      description="Membership grants, Founder claims, entitlements. Benefit changes are audited/versioned."
      queryKey="admin-memberships"
      fetcher={(api, query) => api.getMemberships(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'user', header: 'User', field: 'userId' },
        { id: 'plan', header: 'Plan', field: 'planCode' },
        { id: 'founder', header: 'Founder #', field: 'founderNumber' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
