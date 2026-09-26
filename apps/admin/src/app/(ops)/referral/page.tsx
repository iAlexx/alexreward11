'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Referral"
      description="Referral attribution and reward status."
      queryKey="admin-referral"
      fetcher={(api, query) => api.getReferral(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'inviter', header: 'Inviter', field: 'inviterUserId' },
        { id: 'invitee', header: 'Invitee', field: 'inviteeUserId' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
