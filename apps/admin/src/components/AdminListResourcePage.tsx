'use client';

import { useState, type ReactNode } from 'react';

import { DomainStateView } from './DomainState';
import { DataTable, type DataColumn } from './DataTable';
import { PageHeader } from './PageHeader';
import type { AdminApiClient } from '../lib/admin-api/client';
import type { AdminDomainEnvelope, AdminListPage, AdminListQuery } from '../lib/admin-api/types';
import { useAdminDomainQuery } from '../lib/hooks/useAdminDomainQuery';

const DEFAULT_PAGE_SIZE = 25;

export function AdminListResourcePage<TItem>({
  title,
  description,
  queryKey,
  fetcher,
  columns,
  rowKey,
  toolbar,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly queryKey: string;
  readonly fetcher: (
    api: AdminApiClient,
    query: AdminListQuery,
  ) => Promise<AdminDomainEnvelope<AdminListPage<TItem>>>;
  readonly columns: readonly DataColumn<TItem>[];
  readonly rowKey: (row: TItem) => string;
  readonly toolbar?: ReactNode | undefined;
}) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);

  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    [queryKey, filter, page],
    (api) => {
      const query: AdminListQuery = {
        page,
        pageSize: DEFAULT_PAGE_SIZE,
        ...(filter.trim() === '' ? {} : { q: filter.trim() }),
      };
      return fetcher(api, query);
    },
  );

  return (
    <div className="admin-stack">
      <PageHeader title={title} description={description} actions={toolbar} />
      <DomainStateView
        state={uiState}
        reasonCode={reasonCode}
        onRetry={() => void refetch()}
      >
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={rowKey}
          filter={filter}
          onFilterChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
          page={page}
          pageSize={DEFAULT_PAGE_SIZE}
          totalCount={data?.totalCount ?? null}
          onPageChange={setPage}
        />
      </DomainStateView>
    </div>
  );
}
