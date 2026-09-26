'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

export function UserDetailPage({ userId }: { readonly userId: string }) {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'user', userId],
    (api) => api.getUser(userId),
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="User detail"
        description={`${strings.noBalanceEditor} User id: ${userId}`}
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <dl className="admin-dl">
            <div>
              <dt>Username</dt>
              <dd>{data.username ?? '—'}</dd>
            </div>
            <div>
              <dt>Locale</dt>
              <dd>{data.locale ?? '—'}</dd>
            </div>
            <div>
              <dt>Country</dt>
              <dd>{data.countryCode ?? '—'}</dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.pendingAtomic)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.availableAtomic)}</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.reservedAtomic)}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>
                {data.accountStatus === null ? (
                  '—'
                ) : (
                  <StateBadge
                    state={data.accountStatus}
                    tone={toneForState(data.accountStatus)}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Withdrawal</dt>
              <dd>
                {data.withdrawalStatus === null ? (
                  '—'
                ) : (
                  <StateBadge
                    state={data.withdrawalStatus}
                    tone={toneForState(data.withdrawalStatus)}
                  />
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </DomainStateView>
    </div>
  );
}
