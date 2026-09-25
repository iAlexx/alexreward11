'use client';

import Link from 'next/link';

import { AdminListResourcePage } from '../AdminListResourcePage';
import { StateBadge, toneForState } from '../StateBadge';
import type { AdminUserListItem } from '../../lib/admin-api/types';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';

export function UsersPage() {
  return (
    <AdminListResourcePage<AdminUserListItem>
      title="Users"
      description={strings.noBalanceEditor}
      queryKey="admin-users"
      fetcher={(api, query) => api.listUsers(query)}
      rowKey={(row) => row.userId}
      columns={[
        {
          id: 'user',
          header: 'User',
          cell: (row) => (
            <Link className="admin-link" href={`/users/${encodeURIComponent(row.userId)}`}>
              {row.username ?? row.userId}
            </Link>
          ),
        },
        {
          id: 'pending',
          header: 'Pending',
          cell: (row) => formatOptionalAtomic(row.pendingAtomic),
        },
        {
          id: 'available',
          header: 'Available',
          cell: (row) => formatOptionalAtomic(row.availableAtomic),
        },
        {
          id: 'reserved',
          header: 'Reserved',
          cell: (row) => formatOptionalAtomic(row.reservedAtomic),
        },
        {
          id: 'account',
          header: 'Account',
          cell: (row) =>
            row.accountStatus === null ? (
              '—'
            ) : (
              <StateBadge state={row.accountStatus} tone={toneForState(row.accountStatus)} />
            ),
        },
        {
          id: 'risk',
          header: 'Risk',
          cell: (row) =>
            row.riskTier === null ? (
              '—'
            ) : (
              <StateBadge state={row.riskTier} tone={toneForState(row.riskTier)} />
            ),
        },
      ]}
    />
  );
}
