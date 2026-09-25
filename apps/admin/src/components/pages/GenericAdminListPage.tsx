'use client';

import { AdminListResourcePage } from '../AdminListResourcePage';
import type { AdminApiClient } from '../../lib/admin-api/client';
import type { AdminDomainEnvelope, AdminListPage, AdminListQuery } from '../../lib/admin-api/types';

type Row = Record<string, unknown>;

function stringCell(row: Row, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '—';
}

export function GenericAdminListPage({
  title,
  description,
  queryKey,
  fetcher,
  idKey = 'id',
  columns,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly queryKey: string;
  readonly fetcher: (
    api: AdminApiClient,
    query: AdminListQuery,
  ) => Promise<AdminDomainEnvelope<AdminListPage<Row>>>;
  readonly idKey?: string;
  readonly columns: ReadonlyArray<{ id: string; header: string; field: string }>;
}) {
  return (
    <AdminListResourcePage<Row>
      title={title}
      {...(description === undefined ? {} : { description })}
      queryKey={queryKey}
      fetcher={fetcher}
      rowKey={(row) => stringCell(row, idKey)}
      columns={columns.map((col) => ({
        id: col.id,
        header: col.header,
        cell: (row) => stringCell(row, col.field),
      }))}
    />
  );
}
