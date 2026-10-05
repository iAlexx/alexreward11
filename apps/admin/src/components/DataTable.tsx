'use client';

import type { ReactNode } from 'react';

import { strings } from '../lib/strings';

export type DataColumn<T> = {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  filter,
  onFilterChange,
  page,
  pageSize,
  totalCount,
  onPageChange,
  emptyLabel,
}: {
  readonly columns: readonly DataColumn<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly filter?: string | undefined;
  readonly onFilterChange?: ((value: string) => void) | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly totalCount?: number | null | undefined;
  readonly onPageChange?: ((page: number) => void) | undefined;
  readonly emptyLabel?: string | undefined;
}) {
  const showPager = onPageChange !== undefined && page !== undefined && pageSize !== undefined;

  return (
    <div className="admin-table-wrap">
      {onFilterChange !== undefined ? (
        <div className="admin-table-toolbar">
          <label className="admin-field admin-field--inline">
            <span className="admin-sr-only">{strings.filter}</span>
            <input
              type="search"
              placeholder={strings.search}
              value={filter ?? ''}
              onChange={(e) => onFilterChange(e.target.value)}
              aria-label={strings.filter}
            />
          </label>
        </div>
      ) : null}
      <div className="admin-table-scroll" role="region" aria-label="Results table" tabIndex={0}>
        <table className="admin-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.id} scope="col">
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="admin-muted">
                  {emptyLabel ?? strings.empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((col) => (
                    <td key={col.id}>{col.cell(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {showPager ? (
        <div className="admin-pager" role="navigation" aria-label="Pagination">
          <button
            type="button"
            className="admin-button admin-button--ghost"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            {strings.previous}
          </button>
          <span className="admin-meta">
            {strings.page} {page}
            {totalCount !== null && totalCount !== undefined
              ? ` · ${totalCount} total`
              : ''}
          </span>
          <button
            type="button"
            className="admin-button admin-button--ghost"
            disabled={
              totalCount !== null && totalCount !== undefined
                ? page * pageSize >= totalCount
                : rows.length < pageSize
            }
            onClick={() => onPageChange(page + 1)}
          >
            {strings.next}
          </button>
        </div>
      ) : null}
    </div>
  );
}
