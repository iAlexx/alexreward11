'use client';

import { DomainStateView } from '../DomainState';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';

/**
 * Policy Center — typed/versioned rules only.
 * No arbitrary code/script/eval field in the UI.
 */
export function PolicyCenterPage() {
  const { uiState, data, reasonCode, refetch } = useAdminDomainQuery(
    ['admin', 'policy'],
    (api) => api.getPolicyCenter(),
  );

  const rules = data?.rules ?? [];

  return (
    <div className="admin-stack">
      <PageHeader
        title="Policy Center"
        description="Typed, versioned domain rules. No scripting engine. High-impact changes require old/new diff, reason, reauth, and second confirmation binding the exact payload."
      />
      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        <ul className="admin-stack">
          {rules.map((rule) => (
            <li key={`${rule.family}-${String(rule.version)}`} className="admin-panel">
              <div className="admin-panel__head">
                <h2 className="admin-title-sm">{rule.family}</h2>
                {rule.status === null ? null : (
                  <StateBadge state={rule.status} tone={toneForState(rule.status)} />
                )}
              </div>
              <p className="admin-meta">
                Version: {rule.version === null ? '—' : rule.version} · Effective:{' '}
                {rule.effectiveAt ?? '—'}
              </p>
            </li>
          ))}
        </ul>
        {rules.length === 0 ? <p className="admin-muted">No policy rule rows.</p> : null}
      </DomainStateView>
      <p className="admin-meta">
        Policy edits use structured field forms only. There is no free-form code, script, SQL, or
        eval editor on this surface.
      </p>
    </div>
  );
}
