'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Fraud"
      description="Risk signals and review cases. Phase 14 deepens the fraud engine."
      queryKey="admin-fraud"
      fetcher={(api, query) => api.getFraud(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'user', header: 'User', field: 'userId' },
        { id: 'tier', header: 'Risk tier', field: 'riskTier' },
        { id: 'score', header: 'Score', field: 'score' },
        { id: 'status', header: 'Status', field: 'status' },
      ]}
    />
  );
}
