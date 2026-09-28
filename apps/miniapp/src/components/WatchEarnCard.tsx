'use client';

import type { EarnProviderCardDto } from '@alex-rewards/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { AdsGramRewardedBridge, type AdsGramBridgeEvent } from '../ads/AdsGramRewardedBridge';
import { ApiError, type AttemptVerifyResponse } from '../lib/api/client';
import {
  limitProgressPercent,
  resolveEarnAttemptGate,
} from '../lib/earn/earn-action-gate';
import {
  resolveEarnVerifyOutcome,
  type IssuedVerifyResult,
} from '../lib/earn/earn-verify-outcome';
import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { webConfig } from '../lib/env';
import { EarnRewardDropReceipt } from './EarnRewardDropReceipt';

type WatchUiPhase =
  | 'IDLE'
  | 'PREPARING'
  | 'READY_TO_SHOW'
  | 'WATCHING'
  | 'VERIFYING'
  | 'ISSUED'
  | 'ALREADY_REWARDED'
  | 'NOT_VERIFIED'
  | 'NO_FILL'
  | 'SKIPPED'
  | 'BLOCKED'
  | 'LIMIT_REACHED'
  | 'UNAVAILABLE'
  | 'ERROR';

function monetaryLabel(
  status: EarnProviderCardDto['productionMonetaryStatus'],
  t: ReturnType<typeof useTranslations<'earn'>>,
): string {
  switch (status) {
    case 'APPROVED':
      return t('monetaryApproved');
    case 'BLOCKED':
      return t('monetaryBlocked');
    case 'TEST_ONLY':
      return t('monetaryTestOnly');
    case 'SUSPENDED':
      return t('monetarySuspended');
  }
}

function healthLabel(
  status: EarnProviderCardDto['health']['status'],
  t: ReturnType<typeof useTranslations<'earn'>>,
): string {
  switch (status) {
    case 'HEALTHY':
      return t('healthHealthy');
    case 'DEGRADED':
      return t('healthDegraded');
    case 'UNAVAILABLE':
      return t('healthUnavailable');
    case 'SUSPENDED':
      return t('healthSuspended');
  }
}

export function WatchEarnCard({ provider }: { readonly provider: EarnProviderCardDto }) {
  const t = useTranslations('earn');
  const common = useTranslations('common');
  const { api, accessToken } = useAuth();
  const queryClient = useQueryClient();

  const gate = useMemo(() => resolveEarnAttemptGate(provider), [provider]);

  const [phase, setPhase] = useState<WatchUiPhase>(() => {
    if (gate.reason === 'blocked_monetary') return 'BLOCKED';
    if (gate.reason === 'request_limit' || gate.reason === 'success_limit') return 'LIMIT_REACHED';
    if (
      gate.reason === 'health_unavailable' ||
      gate.reason === 'health_suspended' ||
      gate.reason === 'missing_block_id' ||
      gate.reason === 'missing_authorize_locators' ||
      gate.reason === 'rewarded_use_disallowed'
    ) {
      return 'UNAVAILABLE';
    }
    return 'IDLE';
  });

  const [adSessionId, setAdSessionId] = useState<string | null>(null);
  const [authorizedQuoteAtomic, setAuthorizedQuoteAtomic] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [issuedResult, setIssuedResult] = useState<IssuedVerifyResult | null>(null);
  const [verifySnapshot, setVerifySnapshot] = useState<AttemptVerifyResponse | null>(null);

  const degraded = provider.health.status === 'DEGRADED';
  const requestRemaining = provider.opportunitiesRemaining.request;
  const successRemaining = provider.opportunitiesRemaining.success;
  const requestProgress = limitProgressPercent(requestRemaining);
  const successProgress = limitProgressPercent(successRemaining);

  const invalidateEarn = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.earnSummary(provider.providerCode) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
  }, [provider.providerCode, queryClient]);

  const applyVerifyResult = useCallback(
    async (result: AttemptVerifyResponse) => {
      // Never optimistic: only the server `issued` flag may claim a credit.
      const outcome = resolveEarnVerifyOutcome(result);
      setVerifySnapshot(result);

      if (outcome.kind === 'issued' && outcome.issuedCelebration !== null) {
        if (result.issued) {
          setIssuedResult(outcome.issuedCelebration);
          setPhase('ISSUED');
          setStatusMessage(t('rewardIssued'));
        }
      } else if (outcome.kind === 'already_rewarded') {
        setIssuedResult(null);
        setPhase('ALREADY_REWARDED');
        setStatusMessage(t('alreadyCredited'));
      } else if (outcome.kind === 'monetary_blocked') {
        setIssuedResult(null);
        setPhase('BLOCKED');
        setStatusMessage(t('productionRewardUnavailable'));
      } else {
        setIssuedResult(null);
        setPhase('NOT_VERIFIED');
        setStatusMessage(t('rewardNotVerified'));
      }
      await invalidateEarn();
    },
    [invalidateEarn, t],
  );

  const onSignalReported = useCallback(
    async (event: AdsGramBridgeEvent) => {
      if (event === 'CLIENT_COMPLETION' && adSessionId !== null) {
        // CLIENT_COMPLETION is evidence only — never Reward Drop by itself.
        setPhase('VERIFYING');
        setStatusMessage(t('verifying'));
        try {
          const result = await api.attemptVerifyAdSession(adSessionId);
          await applyVerifyResult(result);
        } catch (error) {
          setPhase('ERROR');
          setErrorMessage(error instanceof ApiError ? error.message : t('rewardNotVerified'));
        }
      } else if (event === 'NO_FILL') {
        setPhase('NO_FILL');
        setStatusMessage(t('noAdAvailable'));
        await invalidateEarn();
      } else if (
        event === 'LOAD_FAILURE' ||
        event === 'START_FAILURE' ||
        event === 'TECHNICAL_FAILURE'
      ) {
        setPhase('ERROR');
        setErrorMessage(t('technicalError'));
        await invalidateEarn();
      } else if (event === 'USER_SKIPPED') {
        setPhase('SKIPPED');
        setStatusMessage(t('attemptIncomplete'));
        await invalidateEarn();
      } else if (event === 'REQUEST_APPROVED' || event === 'AD_STARTED' || event === 'AD_LOADED') {
        setPhase('WATCHING');
      }
    },
    [adSessionId, api, applyVerifyResult, invalidateEarn, t],
  );

  const startWatch = useCallback(async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setIssuedResult(null);
    setVerifySnapshot(null);

    const liveGate = resolveEarnAttemptGate(provider);
    if (!liveGate.canStart) {
      if (liveGate.reason === 'blocked_monetary') {
        setPhase('BLOCKED');
        setStatusMessage(t('productionRewardUnavailable'));
        return;
      }
      if (liveGate.reason === 'request_limit' || liveGate.reason === 'success_limit') {
        setPhase('LIMIT_REACHED');
        setStatusMessage(t('dailyLimitReached'));
        return;
      }
      setPhase('UNAVAILABLE');
      if (liveGate.reason === 'rewarded_use_disallowed') {
        setStatusMessage(t('rewardedUseNotAllowed'));
      } else if (liveGate.reason === 'missing_block_id') {
        setStatusMessage(t('noPlacement'));
      } else if (liveGate.reason === 'missing_authorize_locators') {
        setStatusMessage(t('notConfiguredBody'));
      } else {
        setStatusMessage(t('providerUnavailable'));
      }
      return;
    }

    setPhase('PREPARING');
    try {
      const assetId = provider.authorizeAssetId;
      const budgetPeriodId = provider.authorizeBudgetPeriodId;
      if (assetId === null || budgetPeriodId === null) {
        setPhase('UNAVAILABLE');
        setStatusMessage(t('notConfiguredBody'));
        return;
      }
      const authorized = await api.authorizeAdSession({
        providerCode: provider.providerCode,
        assetId,
        budgetPeriodId,
      });
      setAdSessionId(authorized.adSessionId);
      setAuthorizedQuoteAtomic(
        isAtomicAmountString(authorized.quotedAmountAtomic)
          ? authorized.quotedAmountAtomic
          : null,
      );
      setPhase('READY_TO_SHOW');
    } catch (error) {
      setPhase('ERROR');
      setErrorMessage(error instanceof ApiError ? error.message : common('error'));
    }
  }, [api, common, provider, t]);

  const showWatchChrome =
    adSessionId !== null &&
    provider.blockIdPublic !== null &&
    accessToken !== null &&
    (phase === 'READY_TO_SHOW' || phase === 'WATCHING' || phase === 'VERIFYING');

  const requestBasisLabel =
    requestRemaining.usageBasis === 'SERVER_AUTHORIZED_SESSION_CONSERVATIVE'
      ? t('usageBasisConservative')
      : requestRemaining.usageBasis === 'AUTHORITATIVE_PROVIDER_REQUEST'
        ? t('usageBasisAuthoritativeRequest')
        : t('usageBasisSuccessfulReward');

  const successBasisLabel =
    successRemaining.usageBasis === 'SUCCESSFUL_REWARD'
      ? t('usageBasisSuccessfulReward')
      : successRemaining.usageBasis === 'AUTHORITATIVE_PROVIDER_REQUEST'
        ? t('usageBasisAuthoritativeRequest')
        : t('usageBasisConservative');

  const unavailablePrimary =
    gate.reason === 'blocked_monetary' ||
    gate.reason === 'request_limit' ||
    gate.reason === 'success_limit' ||
    gate.reason === 'health_unavailable' ||
    gate.reason === 'health_suspended' ||
    gate.reason === 'missing_block_id' ||
    gate.reason === 'missing_authorize_locators' ||
    gate.reason === 'rewarded_use_disallowed';

  return (
    <section className="lootra-watch-card" aria-label={t('statusRegion')}>
      {gate.reason === 'blocked_monetary' || phase === 'BLOCKED' ? (
        <div className="alex-banner alex-banner--warn lootra-earn-policy" role="status">
          <p className="alex-title-sm">{t('monetaryBlockedTitle')}</p>
          <p className="alex-muted">{t('monetaryBlockedBody')}</p>
          {provider.reasonCodes.length > 0 ? (
            <p className="alex-meta">
              {common('reasonCodes')}: {provider.reasonCodes.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {degraded ? (
        <p className="alex-banner alex-banner--warn" role="status">
          {t('providerDegraded')}
        </p>
      ) : null}

      <div className="lootra-provider-status">
        <div className="lootra-today-head">
          <h2 className="alex-title-sm">{provider.name}</h2>
          <span className="alex-badge">{provider.providerCode}</span>
        </div>
        <dl className="alex-kv">
          <div>
            <dt>{t('providerStatus')}</dt>
            <dd>
              {monetaryLabel(provider.productionMonetaryStatus, t)} ·{' '}
              {healthLabel(provider.health.status, t)}
            </dd>
          </div>
          <div>
            <dt>{t('utcDay')}</dt>
            <dd>{provider.utcDay}</dd>
          </div>
        </dl>
      </div>

      <div className="lootra-earn-limits">
        <h3 className="alex-title-sm">{t('dailyAvailability')}</h3>
        <div className="lootra-limit-row">
          <div className="lootra-limit-copy">
            <p className="lootra-limit-label">{t('limitRemainingRequest')}</p>
            <p className="alex-meta">{requestBasisLabel}</p>
          </div>
          <p className="lootra-limit-value">
            {requestRemaining.configured
              ? (requestRemaining.remaining ?? '—')
              : t('limitNotConfigured')}
          </p>
        </div>
        {requestProgress !== null ? (
          <div
            className="lootra-limit-bar"
            role="progressbar"
            aria-valuenow={requestProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('limitRemainingRequest')}
          >
            <span style={{ width: `${requestProgress}%` }} />
          </div>
        ) : null}

        <div className="lootra-limit-row">
          <div className="lootra-limit-copy">
            <p className="lootra-limit-label">{t('limitRemainingSuccess')}</p>
            <p className="alex-meta">{successBasisLabel}</p>
          </div>
          <p className="lootra-limit-value">
            {successRemaining.configured
              ? (successRemaining.remaining ?? '—')
              : t('limitNotConfigured')}
          </p>
        </div>
        {successProgress !== null ? (
          <div
            className="lootra-limit-bar"
            role="progressbar"
            aria-valuenow={successProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('limitRemainingSuccess')}
          >
            <span style={{ width: `${successProgress}%` }} />
          </div>
        ) : null}
        {successRemaining.configured && successRemaining.maxCount !== null ? (
          <p className="alex-meta">
            {t('upToNOpportunities', { count: successRemaining.maxCount })}
          </p>
        ) : null}
      </div>

      {authorizedQuoteAtomic !== null &&
      phase !== 'IDLE' &&
      phase !== 'ISSUED' &&
      isAtomicAmountString(authorizedQuoteAtomic) ? (
        <p className="alex-meta">
          {t('authorizedQuote')}: {formatAtomicAmountGrouped(authorizedQuoteAtomic)}{' '}
          {common('baseUnits')}
        </p>
      ) : null}

      {phase === 'PREPARING' ? <p className="alex-muted">{t('preparing')}</p> : null}
      {phase === 'WATCHING' ? <p className="alex-muted">{t('watching')}</p> : null}
      {phase === 'VERIFYING' ? (
        <p className="alex-banner" role="status" aria-live="polite">
          {t('verifying')}
        </p>
      ) : null}
      {phase === 'LIMIT_REACHED' ? (
        <p className="alex-banner alex-banner--warn" role="status">
          {t('dailyLimitReached')}
        </p>
      ) : null}
      {phase === 'NO_FILL' ? (
        <p className="alex-banner" role="status">
          {t('noAdAvailable')}
        </p>
      ) : null}
      {phase === 'SKIPPED' ? (
        <p className="alex-banner" role="status">
          {t('attemptIncomplete')}
        </p>
      ) : null}
      {phase === 'ALREADY_REWARDED' ? (
        <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
          {t('alreadyCredited')}
        </p>
      ) : null}
      {phase === 'NOT_VERIFIED' ? (
        <div className="alex-banner" role="status" aria-live="polite">
          <p>{statusMessage ?? t('rewardNotVerified')}</p>
          {verifySnapshot !== null && verifySnapshot.reasonCodes.length > 0 ? (
            <p className="alex-meta">
              {common('reasonCodes')}: {verifySnapshot.reasonCodes.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
      {errorMessage !== null ? (
        <p className="alex-banner alex-banner--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {issuedResult !== null && phase === 'ISSUED' ? (
        <EarnRewardDropReceipt issued={issuedResult} authorizedQuoteAtomic={authorizedQuoteAtomic} />
      ) : null}

      {showWatchChrome ? (
        <AdsGramRewardedBridge
          adSessionId={adSessionId}
          blockId={provider.blockIdPublic}
          accessToken={accessToken}
          apiBaseUrl={webConfig.NEXT_PUBLIC_API_BASE_URL}
          onSignalReported={onSignalReported}
        >
          {({ showAd, busy }) => (
            <button
              type="button"
              className="lootra-btn lootra-btn--primary lootra-earn-cta"
              disabled={busy || phase === 'VERIFYING'}
              onClick={() => {
                void showAd();
              }}
            >
              {busy || phase === 'WATCHING' ? t('watching') : t('watchNow')}
            </button>
          )}
        </AdsGramRewardedBridge>
      ) : unavailablePrimary || !gate.canStart ? (
        <button type="button" className="lootra-btn lootra-btn--ghost lootra-earn-cta" disabled>
          {gate.reason === 'blocked_monetary'
            ? t('unavailableAction')
            : gate.reason === 'request_limit' || gate.reason === 'success_limit'
              ? t('limitReachedAction')
              : t('unavailableAction')}
        </button>
      ) : (
        <button
          type="button"
          className="lootra-btn lootra-btn--primary lootra-earn-cta"
          disabled={phase === 'PREPARING' || phase === 'ISSUED' || phase === 'ALREADY_REWARDED'}
          onClick={() => {
            void startWatch();
          }}
        >
          {phase === 'PREPARING' ? t('preparing') : t('watchNow')}
        </button>
      )}
    </section>
  );
}
