'use client';

import { useMemo, useState } from 'react';

import { DomainStateView } from '../DomainState';
import { HighImpactCeremony } from '../HighImpactCeremony';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { strings } from '../../lib/strings';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';
import { useAdminSession } from '../../providers/AdminSessionProvider';

/**
 * Feature flags / kill switches.
 * PAYOUT_DISPATCH_PAUSE shown with warning; changes require full ceremony —
 * never an auto-toggle.
 */
export function FeatureFlagsPage() {
  const { api } = useAdminSession();
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'feature-flags'],
    (client) => client.getFeatureFlags(),
  );

  const flags = data?.items ?? [];
  const [ceremonyTarget, setCeremonyTarget] = useState<{
    flagKey: string;
    environment: string;
    enabled: boolean;
    version: number;
    proposedEnabled: boolean;
  } | null>(null);

  const ceremonyPayload = useMemo(() => {
    if (ceremonyTarget === null) return null;
    return {
      flagKey: ceremonyTarget.flagKey,
      environment: ceremonyTarget.environment,
      enabled: ceremonyTarget.proposedEnabled,
    };
  }, [ceremonyTarget]);

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
        {data?.phase10BaselineNote !== undefined ? (
          <p className="admin-meta">{data.phase10BaselineNote}</p>
        ) : null}
      </div>

      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <ul className="admin-flag-list">
          {flags.map((flag) => {
            const isPause = flag.flagKey.toUpperCase() === 'PAYOUT_DISPATCH_PAUSE';
            return (
              <li key={`${flag.flagKey}:${flag.environment}`} className="admin-panel">
                <div className="admin-panel__head">
                  <div>
                    <p className="admin-title-sm">
                      {flag.flagKey}{' '}
                      <span className="admin-meta">({flag.environment})</span>
                    </p>
                    {flag.description !== null ? (
                      <p className="admin-muted">{flag.description}</p>
                    ) : null}
                    <p className="admin-meta">version {flag.version}</p>
                  </div>
                  <StateBadge
                    state={flag.enabled ? 'ON' : 'OFF'}
                    tone={toneForState(flag.enabled ? 'PAUSED' : 'READY')}
                  />
                </div>
                {isPause || flag.requiresExplicitCeremony ? (
                  <button
                    type="button"
                    className="admin-button admin-button--ghost"
                    data-testid={`flag-propose-${flag.flagKey}`}
                    onClick={() => {
                      setCeremonyTarget({
                        flagKey: flag.flagKey,
                        environment: flag.environment,
                        enabled: flag.enabled,
                        version: flag.version,
                        proposedEnabled: !flag.enabled,
                      });
                    }}
                  >
                    Propose change (ceremony)
                  </button>
                ) : (
                  <p className="admin-meta">Low-impact flag — read-only in V1 Admin.</p>
                )}
              </li>
            );
          })}
        </ul>
        {flags.length === 0 ? <p className="admin-muted">{strings.empty}</p> : null}
      </DomainStateView>

      {ceremonyTarget !== null && ceremonyPayload !== null ? (
        <HighImpactCeremony
          title={`Change ${ceremonyTarget.flagKey}`}
          diffs={[
            {
              path: `${ceremonyTarget.flagKey}.enabled`,
              oldValue: ceremonyTarget.enabled,
              newValue: ceremonyTarget.proposedEnabled,
            },
          ]}
          actionType="feature_flags.mutate"
          resourceType="feature_flag"
          resourceId={`${ceremonyTarget.flagKey}:${ceremonyTarget.environment}`}
          expectedVersion={String(ceremonyTarget.version)}
          payload={ceremonyPayload}
          requiresReauth
          onConfirm={async ({ reason, confirmationId }) => {
            await api.mutateFeatureFlag({
              flagKey: ceremonyTarget.flagKey,
              environment: ceremonyTarget.environment,
              enabled: ceremonyTarget.proposedEnabled,
              reason,
              expectedVersion: String(ceremonyTarget.version),
              confirmationId,
            });
            setCeremonyTarget(null);
            await refetch();
          }}
        >
          <p className="admin-muted">{strings.payoutPauseCeremony}</p>
        </HighImpactCeremony>
      ) : null}
    </div>
  );
}
