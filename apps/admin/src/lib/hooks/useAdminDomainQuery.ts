'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { AdminApiError, type AdminApiClient } from '../admin-api/client';
import type { AdminDomainEnvelope, AdminUiState } from '../admin-api/types';
import { useAdminSession } from '../../providers/AdminSessionProvider';

export function useAdminDomainQuery<T>(
  queryKey: readonly unknown[],
  fetcher: (api: AdminApiClient) => Promise<AdminDomainEnvelope<T>>,
) {
  const { api, status: sessionStatus } = useAdminSession();

  const query = useQuery({
    queryKey,
    queryFn: () => fetcher(api),
    enabled: sessionStatus === 'AUTHENTICATED',
  });

  const uiState: AdminUiState = useMemo(() => {
    if (sessionStatus === 'LOADING' || query.isLoading) return 'LOADING';
    if (query.isError) return 'ERROR';
    const envelope = query.data;
    if (envelope === undefined) return 'LOADING';
    if (envelope.status === 'UNAVAILABLE') return 'UNAVAILABLE';
    if (envelope.status === 'EMPTY') return 'EMPTY';
    if (envelope.status === 'DEGRADED') return 'DEGRADED';
    if (envelope.data === null) return 'EMPTY';
    return 'READY';
  }, [sessionStatus, query.isLoading, query.isError, query.data]);

  const errorCode =
    query.error instanceof AdminApiError
      ? query.error.code
      : (query.data?.reasonCode ?? null);

  return {
    ...query,
    uiState,
    envelope: query.data ?? null,
    data: query.data?.data ?? null,
    reasonCode: errorCode,
    refetch: query.refetch,
  };
}
