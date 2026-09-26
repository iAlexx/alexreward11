'use client';

import { useMemo, useState } from 'react';

import { DomainStateView } from '../DomainState';
import { HighImpactCeremony } from '../HighImpactCeremony';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/**
 * Feature flags / kill switches.
 * PAYOUT_DISPATCH_PAUSE shown with warning; changes require full ceremony —
 * never an auto-toggle.
 */
export function FeatureFlagsPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'feature-flags'],
    (api) => api.getFeatureFlags(),
  );

  const flags = data?.flags ?? [];
  const pauseFlag =
    flags.find((f) => f.code.toUpperCase() === 'PAYOUT_DISPATCH_PAUSE') ?? null;

  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [proposedEnabled, setProposedEnabled] = useState(true);

  const currentEnabled = pauseFlag?.enabled ?? null;
  const ceremonyPayload = useMemo(
    () => ({
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment: 'LOCAL',
      enabled: proposedEnabled,
      reason: 'ceremony-pending',
    }),
    [proposedEnabled],
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="Feature Flags"
        description="Granular kill switches. High-impact flags require ceremony, not silent toggles."
      />

      <div className="admin-banner admin-banner--warn" role="status" data-testid="payout-pause-warning">
        <p>
          <strong>PAYOUT_DISPATCH_PAUSE</strong>
        </p>
        <p className="admin-muted">{strings.payoutPauseCeremony}</p>
        {currentEnabled === true ? (
          <p>{strings.payoutPauseWarning}</p>
        ) : currentEnabled === null ? (
          <p className="admin-meta">Current pause state unavailable from API.</p>
        ) : (
          <p className="admin-meta">Dispatch pause flag currently reported off.</p>
        )}
      </div>

      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <ul className="admin-flag-list">
          {flags.map((flag) => {
            const isPause = flag.code.toUpperCase() === 'PAYOUT_DISPATCH_PAUSE';
            return (
              <li key={flag.code} className="admin-panel">
                <div className="admin-panel__head">
                  <div>
                    <p className="admin-title-sm">{flag.code}</p>
                    {flag.description !== null ? (
                      <p className="admin-muted">{flag.description}</p>
                    ) : null}
                  </div>
                  {flag.enabled === null ? (
                    <span className="admin-meta">—</span>
                  ) : (
                    <StateBadge
                      state={flag.enabled ? 'ON' : 'OFF'}
                      tone={toneForState(flag.enabled ? 'PAUSED' : 'READY')}
                    />
                  )}
                </div>
                {isPause || flag.requiresCeremony || flag.highImpact ? (
                  <button
                    type="button"
                    className="admin-button admin-button--ghost"
                    onClick={() => {
                      setProposedEnabled(!(flag.enabled ?? false));
                      setCeremonyOpen(true);
                    }}
                  >
                    Propose change (ceremony)
                  </button>
                ) : (
                  <p className="admin-meta">Read-only until API write path is available.</p>
                )}
              </li>
            );
          })}
        </ul>
        {flags.length === 0 ? <p className="admin-muted">{strings.empty}</p> : null}
      </DomainStateView>

      {ceremonyOpen ? (
        <HighImpactCeremony
          title="Change PAYOUT_DISPATCH_PAUSE"
          diffs={[
            {
              path: 'PAYOUT_DISPATCH_PAUSE.enabled',
              oldValue: currentEnabled,
              newValue: proposedEnabled,
            },
          ]}
          actionType="feature_flags.mutate"
          resourceType="feature_flag"
          resourceId="PAYOUT_DISPATCH_PAUSE:LOCAL"
          expectedVersion="0"
          payload={ceremonyPayload}
          requiresReauth
          onConfirm={async () => {
            // Write path lands with parallel Admin APIs — ceremony UI is mandatory now.
            // Never auto-toggle; refuse until the audited write API exists.
            throw new Error(
              'Feature-flag write API not available yet. No silent toggle applied.',
            );
          }}
        >
          <p className="admin-muted">{strings.payoutPauseCeremony}</p>
        </HighImpactCeremony>
      ) : null}
    </div>
  );
}
