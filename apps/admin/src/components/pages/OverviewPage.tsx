'use client';

import Link from 'next/link';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

export function OverviewPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'overview'],
    (api) => api.getOverview(),
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="Overview"
        description="Owner operations snapshot. Monetary fields are ledger-derived; missing values stay unavailable."
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <div className="admin-metric-grid">
            <Metric
              label="Pending liabilities"
              value={formatOptionalAtomic(data.pendingLiabilitiesAtomic)}
            />
            <Metric
              label="Available liabilities"
              value={formatOptionalAtomic(data.availableLiabilitiesAtomic)}
            />
            <Metric
              label="Reserved liabilities"
              value={formatOptionalAtomic(data.reservedLiabilitiesAtomic)}
            />
            <Metric
              label="Hot Wallet USDT"
              value={formatOptionalAtomic(data.hotWalletUsdtAtomic)}
            />
            <Metric
              label="Open review cases"
              value={data.openReviewCount === null ? '—' : String(data.openReviewCount)}
            />
            <div className="admin-metric">
              <p className="admin-meta">AdsGram monetary</p>
              <p>
                {data.adsgramMonetaryStatus === null ? (
                  '—'
                ) : (
                  <StateBadge
                    state={data.adsgramMonetaryStatus}
                    tone={toneForState(data.adsgramMonetaryStatus)}
                  />
                )}
              </p>
            </div>
            <div className="admin-metric">
              <p className="admin-meta">PAYOUT_DISPATCH_PAUSE</p>
              {data.payoutDispatchPaused === null ? (
                <p>—</p>
              ) : data.payoutDispatchPaused ? (
                <p className="admin-banner admin-banner--warn" role="status">
                  {strings.payoutPauseWarning}
                </p>
              ) : (
                <StateBadge state="DISPATCH_ACTIVE" tone="success" />
              )}
            </div>
          </div>
        ) : null}
        <p className="admin-meta">{strings.noBalanceEditor}</p>
        <p>
          <Link className="admin-link" href="/review-queue">
            Open Review Queue
          </Link>
        </p>
      </DomainStateView>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="admin-metric">
      <p className="admin-meta">{label}</p>
      <p className="admin-metric__value admin-mono">{value}</p>
    </div>
  );
}
