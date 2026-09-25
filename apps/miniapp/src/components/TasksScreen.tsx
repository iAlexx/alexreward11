'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';

export function TasksScreen() {
  const t = useTranslations('tasks');
  const common = useTranslations('common');
  const { api } = useAuth();

  const tasks = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.getTasks(),
  });

  if (tasks.isLoading) return <DomainStateView state="LOADING" />;
  if (tasks.isError || tasks.data === undefined) {
    return <DomainStateView state="ERROR" onRetry={() => void tasks.refetch()} />;
  }

  const data = tasks.data;
  return (
    <div className="alex-stack">
      <h1 className="alex-title">{t('title')}</h1>
      <DomainStateView
        state={data.status === 'READY' && data.items.length === 0 ? 'EMPTY' : data.status}
        reasonCode={data.reasonCode}
        emptyTitle={t('empty')}
        unavailableTitle={t('engineTitle')}
        unavailableBody={t('engineBody')}
        onRetry={data.reasonCode === 'ENGINE_NOT_ENABLED' ? undefined : () => void tasks.refetch()}
      >
        {data.status === 'READY' ? (
          <ul className="alex-list">
            {data.items.map((item) => (
              <li key={item.taskCode} className="alex-card">
                <p className="alex-title-sm">{item.nameKey}</p>
                <p className="alex-muted">
                  {t('progress')}: {item.progressCount}/{item.target} · {item.state}
                </p>
                <p className="alex-meta">{t('missionRewardVariable')}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </DomainStateView>
      {data.reasonCode === 'ENGINE_NOT_ENABLED' ? (
        <p className="alex-meta">{common('engineNotEnabled')}</p>
      ) : null}
    </div>
  );
}
