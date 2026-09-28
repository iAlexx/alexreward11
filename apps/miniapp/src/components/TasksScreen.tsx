'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import type { TaskListItemDto } from '@alex-rewards/contracts';

import { queryKeys } from '../lib/query/keys';
import {
  isKnownTaskState,
  resolveTaskDisplayName,
  safeTaskProgress,
  TASK_STATE_LABEL_KEYS,
} from '../lib/tasks/task-display';
import { useAuth } from '../providers/AuthProvider';
import { DomainStateView } from './DomainState';
import { EngineUnavailableState } from './EngineUnavailableState';
import { TasksSkeleton } from './TasksFriendsSkeleton';

function TasksHero() {
  const t = useTranslations('tasks');

  return (
    <header className="lootra-tasks-hero">
      <div className="lootra-tasks-hero__copy">
        <h1 className="alex-title">{t('title')}</h1>
        <p className="alex-muted">{t('heroSubtitle')}</p>
      </div>
      <div className="lootra-tasks-hero__visual" aria-hidden="true">
        <span className="lootra-tasks-hero__orbit" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-tasks-hero__art"
          src="/brand/lootra/tasks-hero.png"
          alt=""
          width={200}
          height={200}
        />
      </div>
    </header>
  );
}

function TaskRow({ item }: { readonly item: TaskListItemDto }) {
  const t = useTranslations('tasks');
  const title = resolveTaskDisplayName(item.nameKey, t('taskNameFallback'));
  const { progress, target, ratio } = safeTaskProgress(item.progressCount, item.target);
  const stateLabel = isKnownTaskState(item.state)
    ? t(TASK_STATE_LABEL_KEYS[item.state])
    : t('stateUnknown', { state: item.state });

  return (
    <li className="lootra-task-row">
      <div className="lootra-task-row__header">
        <h2 className="alex-title-sm">{title}</h2>
        <span className="lootra-task-state">{stateLabel}</span>
      </div>
      {target > 0 ? (
        <div className="lootra-task-progress" aria-label={t('progress')}>
          <div className="lootra-task-progress__bar" aria-hidden="true">
            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <p className="alex-meta">
            {t('progress')}: {progress}/{target}
          </p>
        </div>
      ) : (
        <p className="alex-meta">
          {t('progress')}: {progress}
        </p>
      )}
      {/* Read-only: COMPLETED does not expose a claim action — no claim endpoint exists. */}
      <p className="alex-meta">{t('rewardServerNote')}</p>
    </li>
  );
}

/**
 * Tasks / Missions screen.
 * ENGINE_NOT_ENABLED is an intentional product state — not empty, not error.
 * READY items (when the engine exists) are read-only server fields only.
 */
export function TasksScreen() {
  const t = useTranslations('tasks');
  const { api } = useAuth();

  const tasks = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.getTasks(),
  });

  if (tasks.isLoading) return <TasksSkeleton />;

  if (tasks.isError || tasks.data === undefined) {
    return (
      <div className="alex-stack lootra-tasks">
        <TasksHero />
        <DomainStateView state="ERROR" onRetry={() => void tasks.refetch()} />
      </div>
    );
  }

  const data = tasks.data;
  const engineDisabled =
    data.status === 'UNAVAILABLE' && data.reasonCode === 'ENGINE_NOT_ENABLED';

  return (
    <div className="alex-stack lootra-tasks">
      <TasksHero />

      {engineDisabled ? (
        <EngineUnavailableState variant="tasks" />
      ) : data.status === 'UNAVAILABLE' ? (
        <DomainStateView
          state="UNAVAILABLE"
          reasonCode={data.reasonCode}
          unavailableTitle={t('unavailable')}
          unavailableBody={t('engineBody')}
          onRetry={() => void tasks.refetch()}
        />
      ) : data.status === 'READY' && data.items.length === 0 ? (
        <DomainStateView state="EMPTY" emptyTitle={t('empty')} emptyBody={t('emptyBody')} />
      ) : data.status === 'READY' ? (
        <section className="lootra-tasks-list-wrap" aria-label={t('title')}>
          <p className="alex-meta">{t('rewardServerNote')}</p>
          <ul className="lootra-tasks-list">
            {data.items.map((item) => (
              <TaskRow key={item.taskCode} item={item} />
            ))}
          </ul>
        </section>
      ) : (
        <DomainStateView
          state={data.status}
          reasonCode={data.reasonCode}
          onRetry={() => void tasks.refetch()}
        />
      )}
    </div>
  );
}
