'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

function TaskRow({
  item,
  onClaim,
  claiming,
}: {
  readonly item: TaskListItemDto;
  readonly onClaim: (progressId: string) => void;
  readonly claiming: boolean;
}) {
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
      {item.rewardAtomic !== null ? (
        <p className="alex-meta">
          {t('rewardServerNote')}: {item.rewardAtomic}
        </p>
      ) : (
        <p className="alex-meta">{t('rewardServerNote')}</p>
      )}
      {item.claimStatus !== null ? (
        <p className="alex-meta">Claim: {item.claimStatus}</p>
      ) : null}
      {item.claimable && item.progressId !== null ? (
        <button
          type="button"
          className="alex-button"
          disabled={claiming}
          onClick={() => onClaim(item.progressId!)}
        >
          {claiming ? '…' : t('claim') ?? 'Claim'}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Tasks / Missions screen — server-authoritative rows only.
 * Claim enabled only when server sets claimable=true.
 */
export function TasksScreen() {
  const t = useTranslations('tasks');
  const { api } = useAuth();
  const queryClient = useQueryClient();

  const tasks = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.getTasks(),
  });

  const claim = useMutation({
    mutationFn: (progressId: string) => api.claimTask(progressId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      await queryClient.invalidateQueries({ queryKey: queryKeys.wallets });
    },
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
          <ul className="lootra-tasks-list">
            {data.items.map((item) => (
              <TaskRow
                key={`${item.taskCode}:${item.missionVersionId}:${item.periodKey}`}
                item={item}
                claiming={claim.isPending}
                onClaim={(progressId) => claim.mutate(progressId)}
              />
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
