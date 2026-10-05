'use client';

import { useMemo, useState, type ReactNode } from 'react';

import { DomainStateView } from '../DomainState';
import { HighImpactCeremony } from '../HighImpactCeremony';
import { PageHeader } from '../PageHeader';
import { StateBadge, toneForState } from '../StateBadge';
import type { AdminFraudEvidenceData } from '../../lib/admin-api/types';
import { useAdminDomainQuery } from '../../lib/hooks/useAdminDomainQuery';
import { useAdminSession } from '../../providers/AdminSessionProvider';

function EvidencePanel({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="admin-panel">
      <header className="admin-panel__head">
        <h2 className="admin-title-sm">{title}</h2>
      </header>
      {children}
    </article>
  );
}

function formatCodes(codes: readonly string[] | undefined): string {
  if (codes === undefined || codes.length === 0) return '—';
  return codes.join(', ');
}

/**
 * Fraud Admin — Phase 14 evidence envelope + FRAUD_REVIEW ensure.
 * Reads via Admin API only (no fraud package import). No safe-clearance control.
 */
export function FraudPage() {
  const { api } = useAdminSession();
  const [userIdInput, setUserIdInput] = useState('');
  const [activeUserId, setActiveUserId] = useState<string | undefined>(undefined);
  const [ensureOpen, setEnsureOpen] = useState(false);

  const { uiState, data, reasonCode, refetch, envelope } = useAdminDomainQuery(
    ['admin', 'fraud', activeUserId ?? ''],
    (client) =>
      client.getFraud(activeUserId !== undefined ? { userId: activeUserId } : {}),
  );

  const evidence = data as AdminFraudEvidenceData | null;
  const phase14Ready =
    envelope !== null &&
    typeof envelope === 'object' &&
    'phase14Engine' in envelope &&
    (envelope as { phase14Engine?: { status?: string } }).phase14Engine?.status === 'READY';

  const ensurePayload = useMemo(
    () =>
      activeUserId !== undefined
        ? { userId: activeUserId, summary: 'Admin-opened FRAUD_REVIEW case' }
        : null,
    [activeUserId],
  );

  return (
    <div className="admin-stack">
      <PageHeader
        title="Fraud"
        description="Risk / Trust / Eligibility evidence and live FRAUD_REVIEW cases. Read-only except ensure review."
      />

      <div className="admin-banner" role="status" data-testid="fraud-engine-ready">
        <p>
          Phase 14 fraud engine:{' '}
          <StateBadge state={phase14Ready ? 'READY' : 'UNKNOWN'} tone="neutral" />
        </p>
        <p className="admin-muted">
          Safe-status clearance and Risk/Trust mutations are not available from Admin. Review
          cases are operational only — domain commands remain authority.
        </p>
      </div>

      <form
        className="admin-panel admin-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = userIdInput.trim();
          setActiveUserId(trimmed === '' ? undefined : trimmed);
        }}
      >
        <label className="admin-field" htmlFor="fraud-user-id">
          <span>User ID</span>
          <input
            id="fraud-user-id"
            value={userIdInput}
            onChange={(event) => setUserIdInput(event.target.value)}
            placeholder="UUID"
            data-testid="fraud-user-id"
          />
        </label>
        <div className="admin-actions">
          <button type="submit" className="admin-button" data-testid="fraud-load">
            Load evidence
          </button>
          {activeUserId !== undefined ? (
            <button
              type="button"
              className="admin-button admin-button--ghost"
              data-testid="fraud-ensure-open"
              onClick={() => setEnsureOpen(true)}
            >
              Ensure FRAUD_REVIEW
            </button>
          ) : null}
        </div>
      </form>

      <DomainStateView state={uiState} reasonCode={reasonCode} onRetry={() => void refetch()}>
        {evidence === null ? (
          <p className="admin-muted">No fraud evidence for this query.</p>
        ) : (
          <div className="admin-stack">
            <EvidencePanel title="Current risk profile">
              {evidence.riskProfile === null ? (
                <p className="admin-muted">No risk profile.</p>
              ) : (
                <>
                  <p>
                    Score {evidence.riskProfile.score} ·{' '}
                    <StateBadge
                      state={evidence.riskProfile.riskTier}
                      tone={toneForState(evidence.riskProfile.riskTier)}
                    />{' '}
                    · rule v{evidence.riskProfile.ruleVersion}
                  </p>
                  <p className="admin-meta">
                    Reasons: {formatCodes(evidence.riskProfile.reasonCodes)}
                  </p>
                  <p className="admin-meta">
                    Calculated: {evidence.riskProfile.calculatedAt}
                  </p>
                </>
              )}
            </EvidencePanel>

            <EvidencePanel title="Latest risk snapshot">
              {evidence.latestRiskSnapshot === null ? (
                <p className="admin-muted">No risk snapshot.</p>
              ) : (
                <>
                  <p className="admin-meta">id {evidence.latestRiskSnapshot.id}</p>
                  <p>
                    {evidence.latestRiskSnapshot.decisionScope} · score{' '}
                    {evidence.latestRiskSnapshot.score} ·{' '}
                    <StateBadge
                      state={evidence.latestRiskSnapshot.riskTier}
                      tone={toneForState(evidence.latestRiskSnapshot.riskTier)}
                    />
                  </p>
                  <p className="admin-meta">
                    Safe aggregates:{' '}
                    {JSON.stringify(evidence.latestRiskSnapshot.safeAggregates)}
                  </p>
                </>
              )}
            </EvidencePanel>

            <EvidencePanel title="Trust">
              <p>
                Current:{' '}
                {evidence.trustCurrent === null
                  ? '—'
                  : evidence.trustCurrent.trustState}
              </p>
              {evidence.latestTrustSnapshot === null ? (
                <p className="admin-muted">No trust snapshot.</p>
              ) : (
                <p className="admin-meta">
                  Latest snapshot v{evidence.latestTrustSnapshot.ruleVersion} ·{' '}
                  {evidence.latestTrustSnapshot.trustState} · score{' '}
                  {evidence.latestTrustSnapshot.trustScore}
                </p>
              )}
            </EvidencePanel>

            <EvidencePanel title="Recent eligibility decisions">
              {evidence.recentEligibilityDecisions.length === 0 ? (
                <p className="admin-muted">None.</p>
              ) : (
                <ul className="admin-flag-list">
                  {evidence.recentEligibilityDecisions.map((d) => (
                    <li key={d.id} className="admin-meta">
                      {d.actionType} · {d.outcome} · policy v{d.policyVersion ?? '—'} ·{' '}
                      {formatCodes(d.reasonCodes)} · {d.decidedAt}
                    </li>
                  ))}
                </ul>
              )}
            </EvidencePanel>

            <EvidencePanel title="Open / confirmed fraud flags">
              {evidence.openOrConfirmedFraudFlags.length === 0 ? (
                <p className="admin-muted">None.</p>
              ) : (
                <ul className="admin-flag-list">
                  {evidence.openOrConfirmedFraudFlags.map((f) => (
                    <li key={f.id}>
                      <StateBadge state={f.status} tone={toneForState(f.status)} /> {f.flagType}{' '}
                      ({f.severity}) · {f.createdAt}
                    </li>
                  ))}
                </ul>
              )}
            </EvidencePanel>

            <EvidencePanel title="Live FRAUD_REVIEW cases">
              {evidence.liveFraudReviewCases.length === 0 ? (
                <p className="admin-muted">None.</p>
              ) : (
                <ul className="admin-flag-list">
                  {evidence.liveFraudReviewCases.map((c) => (
                    <li key={c.id}>
                      <StateBadge state={c.state} tone={toneForState(c.state)} /> {c.resourceId}{' '}
                      · {c.priority} · {c.summary ?? '—'}
                    </li>
                  ))}
                </ul>
              )}
            </EvidencePanel>
          </div>
        )}
      </DomainStateView>

      {ensureOpen && activeUserId !== undefined && ensurePayload !== null ? (
        <HighImpactCeremony
          title="Ensure FRAUD_REVIEW case"
          diffs={[
            {
              path: 'review_cases.case_type',
              oldValue: null,
              newValue: 'FRAUD_REVIEW',
            },
            {
              path: 'review_cases.resource_id',
              oldValue: null,
              newValue: activeUserId,
            },
          ]}
          actionType="fraud.ensure_review"
          resourceType="user"
          resourceId={activeUserId}
          expectedVersion="1"
          payload={ensurePayload}
          requiresReauth
          onConfirm={async ({ reason, confirmationId }) => {
            await api.ensureFraudReview({
              userId: activeUserId,
              reason,
              expectedVersion: '1',
              confirmationId,
              summary: 'Admin-opened FRAUD_REVIEW case',
            });
            setEnsureOpen(false);
            await refetch();
          }}
        >
          <p className="admin-muted">
            Opens or reuses one live FRAUD_REVIEW case for this user. Does not clear fraud
            status or mutate Risk/Trust.
          </p>
        </HighImpactCeremony>
      ) : null}
    </div>
  );
}
