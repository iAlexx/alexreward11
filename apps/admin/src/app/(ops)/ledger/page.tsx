'use client';

import { GenericAdminListPage } from '../../../components/pages/GenericAdminListPage';

export default function Page() {
  return (
    <GenericAdminListPage
      title="Ledger"
      description="Immutable ledger read model. No balance editor."
      queryKey="admin-ledger"
      fetcher={(api, query) => api.listLedger(query)}
      columns={[
        { id: 'id', header: 'Id', field: 'id' },
        { id: 'type', header: 'Type', field: 'type' },
        { id: 'amount', header: 'Amount atomic', field: 'amountAtomic' },
        { id: 'createdAt', header: 'Created', field: 'createdAt' },
      ]}
    />
  );
}
