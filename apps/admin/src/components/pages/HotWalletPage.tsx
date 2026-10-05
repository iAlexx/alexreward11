'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { formatOptionalAtomic } from '../../lib/money/format';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/** Hot Wallet admin — public fields only. Never private key / seed. */
export function HotWalletPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'hot-wallet'],
    (api) => api.getHotWallet(),
  );

  return (
    <div className="admin-stack">
      <PageHeader title="Hot Wallet" description={strings.hotWalletPublicOnly} />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {data !== null ? (
          <dl className="admin-dl">
            <div>
              <dt>Address</dt>
              <dd className="admin-mono">{data.address ?? '—'}</dd>
            </div>
            <div>
              <dt>Wallet version</dt>
              <dd>{data.walletVersion ?? '—'}</dd>
            </div>
            <div>
              <dt>Signer type</dt>
              <dd>{data.signerType ?? '—'}</dd>
            </div>
            <div>
              <dt>USDT</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.usdtAtomic)}</dd>
            </div>
            <div>
              <dt>TON</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.tonAtomic)}</dd>
            </div>
            <div>
              <dt>Last chain sync</dt>
              <dd>{data.lastChainSyncAt ?? '—'}</dd>
            </div>
            <div>
              <dt>Reserved payouts</dt>
              <dd className="admin-mono">{formatOptionalAtomic(data.reservedPayoutsAtomic)}</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>{data.coverageRatio ?? '—'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {data.status === null ? (
                  '—'
                ) : (
                  <StateBadge state={data.status} tone={toneForState(data.status)} />
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </DomainStateView>
    </div>
  );
}
