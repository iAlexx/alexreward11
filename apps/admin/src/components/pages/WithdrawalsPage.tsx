'use client';

import { AdminListResourcePage } from '../AdminListResourcePage';
import { StateBadge, toneForState } from '../StateBadge';
import type { AdminWithdrawalListItem } from '../../lib/admin-api/types';
import { formatOptionalAtomic } from '../../lib/money/format';

export function WithdrawalsPage() {
  return (
    <AdminListResourcePage<AdminWithdrawalListItem>
      title="Withdrawals"
      description="Withdrawal queue and status. Approvals use high-impact ceremony where configured."
      queryKey="admin-withdrawals"
      fetcher={(api, query) => api.listWithdrawals(query)}
      rowKey={(row) => row.id}
      columns={[
        { id: 'publicId', header: 'Public id', cell: (row) => row.publicId },
        { id: 'user', header: 'User', cell: (row) => row.userId },
        {
          id: 'state',
          header: 'State',
          cell: (row) => <StateBadge state={row.state} tone={toneForState(row.state)} />,
        },
        {
          id: 'requested',
          header: 'Requested',
          cell: (row) => formatOptionalAtomic(row.requestedAmountAtomic),
        },
        {
          id: 'fee',
          header: 'Fee',
          cell: (row) => formatOptionalAtomic(row.feeAmountAtomic),
        },
        {
          id: 'net',
          header: 'Net',
          cell: (row) => formatOptionalAtomic(row.netAmountAtomic),
        },
        {
          id: 'priority',
          header: 'Priority',
          cell: (row) =>
            row.priorityReview === null ? '—' : row.priorityReview ? 'Yes' : 'No',
        },
      ]}
    />
  );
}
