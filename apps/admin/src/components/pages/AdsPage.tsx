'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge } from '../StateBadge';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/**
 * Ads admin — AdsGram production monetary status displayed BLOCKED;
 * APPROVED control disabled with refused messaging pending clarification.
 */
export function AdsPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'ads'],
    (api) => api.getAdsStatus(),
  );

  const providers = data?.providers ?? [];
  const otherProviders = providers.filter((p) => p.providerCode.toUpperCase() !== 'ADSGRAM');

  return (
    <div className="admin-stack">
      <PageHeader
        title="Ads"
        description="Provider monetary eligibility and operational status."
      />

      <div className="admin-banner admin-banner--warn" role="status" data-testid="adsgram-blocked">
        <p>
          <strong>{strings.adsgramBlocked}</strong>
        </p>
        <p className="admin-muted">{strings.adsgramApproveDisabled}</p>
      </div>

      <article className="admin-panel" data-testid="adsgram-provider-card">
        <header className="admin-panel__head">
          <h2 className="admin-title-sm">AdsGram</h2>
          <StateBadge state="BLOCKED" tone="error" />
        </header>
        <p className="admin-muted">
          Production monetary rewards remain blocked pending provider security/correlation
          clarification.
        </p>
        <button
          type="button"
          className="admin-button"
          disabled
          aria-disabled="true"
          title={strings.adsgramApproveDisabled}
        >
          Set APPROVED
        </button>
        <p className="admin-meta" role="status">
          {strings.adsgramApproveDisabled}
        </p>
      </article>

      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {otherProviders.length > 0 ? (
          <div className="admin-stack">
            {otherProviders.map((provider) => (
              <article key={provider.providerCode} className="admin-panel">
                <header className="admin-panel__head">
                  <h2 className="admin-title-sm">
                    {provider.displayName ?? provider.providerCode}
                  </h2>
                  <StateBadge
                    state={provider.productionMonetaryStatus}
                    tone={
                      provider.productionMonetaryStatus === 'BLOCKED' ? 'error' : 'neutral'
                    }
                  />
                </header>
              </article>
            ))}
          </div>
        ) : (
          <p className="admin-meta">No additional provider rows from API.</p>
        )}
      </DomainStateView>
    </div>
  );
}
