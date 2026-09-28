'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import type { IssuedVerifyResult } from '../lib/earn/earn-verify-outcome';
import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';

function maybeSuccessHaptic(): void {
  try {
    const haptic = window.Telegram?.WebApp?.HapticFeedback;
    haptic?.notificationOccurred('success');
  } catch {
    // Haptic must never affect functionality.
  }
}

/**
 * LOOTRA Reward Drop + smoked receipt.
 * Props require IssuedVerifyResult — impossible to render for issued !== true.
 */
export function EarnRewardDropReceipt({
  issued,
  authorizedQuoteAtomic,
}: {
  readonly issued: IssuedVerifyResult;
  readonly authorizedQuoteAtomic: string | null;
}) {
  const t = useTranslations('earn');
  const common = useTranslations('common');

  useEffect(() => {
    maybeSuccessHaptic();
  }, []);

  const base =
    issued.baseAmountAtomic !== null && isAtomicAmountString(issued.baseAmountAtomic)
      ? formatAtomicAmountGrouped(issued.baseAmountAtomic)
      : null;
  const bonus =
    issued.membershipBonusAmountAtomic !== null &&
    isAtomicAmountString(issued.membershipBonusAmountAtomic)
      ? formatAtomicAmountGrouped(issued.membershipBonusAmountAtomic)
      : null;
  const quote =
    authorizedQuoteAtomic !== null && isAtomicAmountString(authorizedQuoteAtomic)
      ? formatAtomicAmountGrouped(authorizedQuoteAtomic)
      : null;

  return (
    <div className="lootra-reward-drop" role="status" aria-live="polite">
      <div className="lootra-reward-drop__stage" aria-hidden="true">
        <span className="lootra-reward-drop__orbit" />
        <span className="lootra-reward-drop__bloom" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-reward-drop__art"
          src="/brand/lootra/rewards-hero.png"
          alt=""
          width={220}
          height={220}
        />
      </div>

      <div className="lootra-reward-receipt">
        <h3 className="lootra-reward-receipt__title">{t('rewardIssued')}</h3>
        <p className="alex-muted">{t('rewardIssuedBody')}</p>

        {quote !== null ? (
          <p className="alex-meta">
            {t('authorizedQuote')}: {quote} {common('baseUnits')}
          </p>
        ) : null}

        <dl className="alex-kv lootra-reward-receipt__kv">
          {base !== null ? (
            <div>
              <dt>{t('baseReward')}</dt>
              <dd>
                {base} <span className="alex-meta">{common('baseUnits')}</span>
              </dd>
            </div>
          ) : null}
          {bonus !== null ? (
            <div>
              <dt>{t('membershipBonus')}</dt>
              <dd>
                {bonus} <span className="alex-meta">{common('baseUnits')}</span>
              </dd>
            </div>
          ) : null}
          {issued.pendingUntil !== null ? (
            <div>
              <dt>{t('pendingUntil')}</dt>
              <dd>{issued.pendingUntil}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
