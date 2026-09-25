'use client';

import type { EarnProviderCardDto } from '@alex-rewards/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  AdsGramRewardedBridge,
  type AdsGramBridgeEvent,
} from '../ads/AdsGramRewardedBridge';
import { ApiError } from '../lib/api/client';
import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { webConfig } from '../lib/env';

type WatchPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'watching'
  | 'verifying'
  | 'complete'
  | 'blocked'
  | 'unavailable'
  | 'error';

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

  const [phase, setPhase] = useState<WatchPhase>('idle');
  const [adSessionId, setAdSessionId] = useState<string | null>(null);
  const [quotedAtomic, setQuotedAtomic] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const blocked =
    provider.productionMonetaryStatus === 'BLOCKED' || provider.monetaryEligible === false;
  const degraded = provider.health.status === 'DEGRADED';
  const canConfigure =
    provider.blockIdPublic !== null &&
    provider.authorizeAssetId !== null &&
    provider.authorizeBudgetPeriodId !== null &&
    provider.rewardedUseAllowed;

  const requestRemaining = provider.opportunitiesRemaining.request;
  const successRemaining = provider.opportunitiesRemaining.success;
  const atRequestLimit =
    requestRemaining.configured && requestRemaining.remaining !== null && requestRemaining.remaining <= 0;
  const atSuccessLimit =
    successRemaining.configured && successRemaining.remaining !== null && successRemaining.remaining <= 0;

  const invalidateEarn = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.earnSummary(provider.providerCode) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
  }, [provider.providerCode, queryClient]);

  const onSignalReported = useCallback(
    async (event: AdsGramBridgeEvent) => {
      if (event === 'CLIENT_COMPLETION' && adSessionId !== null) {
        setPhase('verifying');
        setVerifyMessage(t('checkingCompletion'));
        try {
          const result = await api.attemptVerifyAdSession(adSessionId);
          // Never optimistic: only the server `issued` flag may claim a credit.
          if (result.issued || result.alreadyRewarded) {
            setVerifyMessage(t('rewardAdded'));
            if (
              result.baseAmountAtomic !== null &&
              isAtomicAmountString(result.baseAmountAtomic)
            ) {
              setQuotedAtomic(formatAtomicAmount(result.baseAmountAtomic));
            }
          } else if (
            result.monetary !== null &&
            result.monetary.eligible === false
          ) {
            setVerifyMessage(t('productionRewardUnavailable'));
          } else {
            setVerifyMessage(t('rewardNotVerified'));
          }
          setPhase('complete');
          await invalidateEarn();
        } catch (error) {
          setPhase('error');
          setErrorMessage(
            error instanceof ApiError ? error.message : t('rewardNotVerified'),
          );
        }
      } else if (
        event === 'NO_FILL' ||
        event === 'LOAD_FAILURE' ||
        event === 'START_FAILURE' ||
        event === 'TECHNICAL_FAILURE'
      ) {
        setPhase('unavailable');
        setVerifyMessage(t('noAdAvailable'));
        await invalidateEarn();
      } else if (event === 'USER_SKIPPED') {
        setPhase('complete');
        setVerifyMessage(t('attemptIncomplete'));
        await invalidateEarn();
      } else if (event === 'REQUEST_APPROVED' || event === 'AD_STARTED' || event === 'AD_LOADED') {
        setPhase('watching');
      }
    },
    [adSessionId, api, invalidateEarn, t],
  );

  const startWatch = useCallback(async () => {
    setErrorMessage(null);
    setVerifyMessage(null);

    if (blocked) {
      setPhase('blocked');
      setVerifyMessage(t('productionRewardUnavailable'));
      return;
    }
    if (!provider.rewardedUseAllowed) {
      setPhase('unavailable');
      setVerifyMessage(t('rewardedUseNotAllowed'));
      return;
    }
    if (provider.blockIdPublic === null) {
      setPhase('unavailable');
      setVerifyMessage(t('noPlacement'));
      return;
    }
    if (
      provider.authorizeAssetId === null ||
      provider.authorizeBudgetPeriodId === null
    ) {
      setPhase('unavailable');
      setVerifyMessage(t('notConfiguredBody'));
      return;
    }
    if (atRequestLimit || atSuccessLimit) {
      setPhase('unavailable');
      setVerifyMessage(t('dailyLimitReached'));
      return;
    }

    setPhase('preparing');
    try {
      const authorized = await api.authorizeAdSession({
        providerCode: provider.providerCode,
        assetId: provider.authorizeAssetId,
        budgetPeriodId: provider.authorizeBudgetPeriodId,
      });
      setAdSessionId(authorized.adSessionId);
      setQuotedAtomic(
        isAtomicAmountString(authorized.quotedAmountAtomic)
          ? formatAtomicAmount(authorized.quotedAmountAtomic)
          : null,
      );
      setPhase('ready');
    } catch (error) {
      setPhase('error');
      setErrorMessage(error instanceof ApiError ? error.message : common('error'));
    }
  }, [
    api,
    atRequestLimit,
    atSuccessLimit,
    blocked,
    common,
    provider.authorizeAssetId,
    provider.authorizeBudgetPeriodId,
    provider.blockIdPublic,
    provider.providerCode,
    provider.rewardedUseAllowed,
    t,
  ]);

  const showWatchChrome =
    adSessionId !== null &&
    provider.blockIdPublic !== null &&
    accessToken !== null &&
    (phase === 'ready' || phase === 'watching' || phase === 'verifying');

  return (
    <section className="alex-card" aria-label={t('statusRegion')}>
      <header className="alex-stack-sm">
        <h2 className="alex-title-sm">{t('watchEarn')}</h2>
        <p className="alex-muted">{t('rewardForViewingNotClick')}</p>
        <p className="alex-muted">{t('variableRewardNotice')}</p>
      </header>

      {blocked ? (
        <div className="alex-banner alex-banner--warn" role="status">
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

      {!canConfigure && !blocked ? (
        <div className="alex-banner" role="status">
          <p className="alex-title-sm">{t('notConfiguredTitle')}</p>
          <p className="alex-muted">{t('notConfiguredBody')}</p>
        </div>
      ) : null}

      <dl className="alex-kv">
        <div>
          <dt>{t('providerStatus')}</dt>
          <dd>
            {monetaryLabel(provider.productionMonetaryStatus, t)} ·{' '}
            {healthLabel(provider.health.status, t)}
          </dd>
        </div>
        <div>
          <dt>{t('limitRemainingRequest')}</dt>
          <dd>
            {requestRemaining.configured
              ? (requestRemaining.remaining ?? '—')
              : t('limitNotConfigured')}
          </dd>
        </div>
        <div>
          <dt>{t('limitRemainingSuccess')}</dt>
          <dd>
            {successRemaining.configured
              ? (successRemaining.remaining ?? '—')
              : t('limitNotConfigured')}
          </dd>
        </div>
        {successRemaining.configured && successRemaining.maxCount !== null ? (
          <div>
            <dt>{t('upToNOpportunities', { count: successRemaining.maxCount })}</dt>
            <dd />
          </div>
        ) : null}
        {quotedAtomic !== null && phase !== 'idle' ? (
          <div>
            <dt>{t('quotedReward')}</dt>
            <dd>
              {quotedAtomic} <span className="alex-meta">{common('baseUnits')}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      {phase === 'preparing' ? <p className="alex-muted">{t('preparing')}</p> : null}
      {phase === 'watching' ? <p className="alex-muted">{t('watching')}</p> : null}
      {phase === 'verifying' || verifyMessage !== null ? (
        <p className="alex-banner" role="status">
          {verifyMessage}
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p className="alex-banner alex-banner--error" role="alert">
          {errorMessage}
        </p>
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
              className="alex-button"
              disabled={busy || phase === 'verifying'}
              onClick={() => {
                void showAd();
              }}
            >
              {busy ? t('watching') : t('watchNow')}
            </button>
          )}
        </AdsGramRewardedBridge>
      ) : (
        <button
          type="button"
          className="alex-button"
          disabled={phase === 'preparing'}
          onClick={() => {
            void startWatch();
          }}
        >
          {phase === 'preparing' ? t('preparing') : t('watchNow')}
        </button>
      )}
    </section>
  );
}
