'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  ApiError,
  type WithdrawalListItem,
  type WithdrawalQuoteResponse,
} from '../lib/api/client';
import {
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import {
  AmbiguousConfirmError,
  findWithdrawalByQuoteId,
  isAmbiguousTransportFailure,
} from '../lib/wallet/confirm-ambiguity';
import { createQuoteIdempotencyStore } from '../lib/wallet/quote-idempotency';
import {
  isPositiveAtomicAmountInput,
  isQuoteExpired,
} from '../lib/wallet/wallet-format';
import {
  isKnownWithdrawalState,
  withdrawalStateMessageKey,
} from '../lib/wallet/withdrawal-states';
import { useAuth } from '../providers/AuthProvider';

const QUOTE_ERROR_CODES = new Set([
  'ACCOUNT_BLOCKED',
  'QUOTE_NOT_FOUND',
  'QUOTE_NOT_OPEN',
  'QUOTE_EXPIRED',
  'QUOTE_CONSUMED',
  'VALIDATION',
  'LIMIT_EXCEEDED',
  'LIMIT_RULE_NOT_FOUND',
  'INSUFFICIENT_AVAILABLE',
  'WALLET_INELIGIBLE',
  'COOLDOWN_ACTIVE',
  'PAUSED',
  'FEE_RULE_NOT_FOUND',
]);

/**
 * Withdrawal quote + confirm UI.
 *
 * Fees, net, and expiry are displayed exactly as returned by POST /v1/withdrawals/quote.
 * The Mini App never computes platform fees or net amounts locally.
 * One idempotency key is reused for every retry of the same quote.
 */
export function WalletWithdrawalQuote({
  eligible,
}: {
  readonly eligible: boolean;
}) {
  const t = useTranslations('wallet');
  const common = useTranslations('common');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const idempotency = useRef(createQuoteIdempotencyStore()).current;

  const [amountAtomic, setAmountAtomic] = useState('');
  const [quote, setQuote] = useState<WithdrawalQuoteResponse | null>(null);
  const [created, setCreated] = useState<WithdrawalListItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [quoteExpiredLocal, setQuoteExpiredLocal] = useState(false);

  function mapQuoteError(err: unknown): string {
    if (err instanceof ApiError && QUOTE_ERROR_CODES.has(err.code)) {
      return t(`quoteError_${err.code}` as 'quoteFailed');
    }
    return t('quoteFailed');
  }

  function clearQuoteLocal(active: WithdrawalQuoteResponse | null) {
    if (active !== null) {
      idempotency.clear(active.id);
    }
    setQuote(null);
    setQuoteExpiredLocal(false);
  }

  const quoteMutation = useMutation({
    mutationFn: async (amount: string) => api.createWithdrawalQuote(amount),
    onSuccess: (data) => {
      setError(null);
      setMessage(null);
      setAmbiguous(false);
      setCreated(null);
      setQuoteExpiredLocal(false);
      setQuote(data);
      // Ensure a stable key exists for this quote before any confirm attempt.
      idempotency.getOrCreate(data.id);
    },
    onError: (err: unknown) => {
      clearQuoteLocal(quote);
      setMessage(null);
      setAmbiguous(false);
      setError(mapQuoteError(err));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (activeQuote: WithdrawalQuoteResponse) =>
      api.cancelWithdrawalQuote(activeQuote.id),
    onSuccess: (_data, activeQuote) => {
      clearQuoteLocal(activeQuote);
      setAmountAtomic('');
      setError(null);
      setAmbiguous(false);
      setMessage(t('quoteCancelled'));
    },
    onError: (err: unknown) => {
      setMessage(null);
      setError(mapQuoteError(err));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (activeQuote: WithdrawalQuoteResponse) => {
      const idempotencyKey = idempotency.getOrCreate(activeQuote.id);
      try {
        return await api.createWithdrawal({
          quoteId: activeQuote.id,
          idempotencyKey,
        });
      } catch (err) {
        if (isAmbiguousTransportFailure(err)) {
          throw new AmbiguousConfirmError();
        }
        throw err;
      }
    },
    onSuccess: async (result) => {
      idempotency.clear(result.quoteId);
      setQuote(null);
      setAmountAtomic('');
      setError(null);
      setAmbiguous(false);
      setQuoteExpiredLocal(false);
      setCreated(result);
      setMessage(t('confirmSuccess'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.withdrawals });
      await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.withdrawal(result.id),
      });
    },
    onError: async (err: unknown, activeQuote) => {
      setMessage(null);
      if (err instanceof AmbiguousConfirmError) {
        setAmbiguous(true);
        setError(t('confirmUncertain'));
        // Reconcile against server list — do NOT auto-resend.
        try {
          const list = await api.getWithdrawals();
          const match = findWithdrawalByQuoteId(list.withdrawals, activeQuote.id);
          if (match !== null) {
            setAmbiguous(false);
            setError(null);
            idempotency.clear(activeQuote.id);
            setQuote(null);
            setAmountAtomic('');
            setCreated(match);
            setMessage(t('confirmSuccess'));
            await queryClient.invalidateQueries({ queryKey: queryKeys.withdrawals });
            await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
            await queryClient.invalidateQueries({ queryKey: queryKeys.home });
            await queryClient.invalidateQueries({
              queryKey: queryKeys.withdrawal(match.id),
            });
          }
        } catch {
          // Keep uncertain state; user may Retry with the same idempotency key.
        }
        return;
      }
      setAmbiguous(false);
      if (err instanceof ApiError && QUOTE_ERROR_CODES.has(err.code)) {
        setError(t(`quoteError_${err.code}` as 'confirmFailed'));
      } else {
        setError(t('confirmFailed'));
      }
    },
  });

  const amountValid = isPositiveAtomicAmountInput(amountAtomic);
  const quoteLocked = quote !== null;
  const busy =
    quoteMutation.isPending || cancelMutation.isPending || confirmMutation.isPending;

  function handleConfirmClick() {
    if (quote === null || busy) return;
    if (isQuoteExpired(quote.expiresAt)) {
      setQuoteExpiredLocal(true);
      setError(t('quoteExpired'));
      return;
    }
    setQuoteExpiredLocal(false);
    confirmMutation.mutate(quote);
  }

  if (!eligible && quote === null && created === null) {
    return (
      <section className="lootra-wallet-card" aria-label={t('quoteTitle')}>
        <h2 className="alex-title-sm">{t('quoteTitle')}</h2>
        <p className="alex-muted">{t('withdrawDisabledHint')}</p>
        <button type="button" className="lootra-btn lootra-btn--primary" disabled>
          {t('quoteSubmit')}
        </button>
      </section>
    );
  }

  return (
    <section className="lootra-wallet-card" aria-label={t('quoteTitle')}>
      <h2 className="alex-title-sm">{t('quoteTitle')}</h2>
      <p className="alex-muted">{t('quoteHelp')}</p>

      {created !== null ? (
        <div className="alex-stack-sm lootra-withdraw-success" role="status" aria-live="polite">
          <p className="alex-title-sm">{t('confirmSuccess')}</p>
          <p className="alex-meta">
            {t('withdrawalPublicId')}: {created.publicId}
          </p>
          <p className="alex-meta">
            {t('withdrawalState')}:{' '}
            {isKnownWithdrawalState(created.state)
              ? t(withdrawalStateMessageKey(created.state) as 'state_REQUESTED')
              : t('stateUnknown', { state: created.state })}
          </p>
          <p className="alex-meta">
            {t('withdrawalRequested')}:{' '}
            {isAtomicAmountString(created.requestedAmountAtomic)
              ? formatAtomicAmountGrouped(created.requestedAmountAtomic)
              : '—'}{' '}
            <span>{common('baseUnits')}</span>
          </p>
          <p className="alex-meta">
            {t('withdrawalFee')}:{' '}
            {isAtomicAmountString(created.feeAmountAtomic)
              ? formatAtomicAmountGrouped(created.feeAmountAtomic)
              : '—'}
          </p>
          <p className="alex-meta">
            {t('withdrawalNet')}:{' '}
            {isAtomicAmountString(created.netAmountAtomic)
              ? formatAtomicAmountGrouped(created.netAmountAtomic)
              : '—'}
          </p>
          <button
            type="button"
            className="lootra-btn lootra-btn--ghost"
            onClick={() => {
              setCreated(null);
              setMessage(null);
            }}
          >
            {t('quoteSubmit')}
          </button>
        </div>
      ) : null}

      {created === null && !quoteLocked ? (
        <form
          className="alex-stack"
          onSubmit={(event) => {
            event.preventDefault();
            const amount = amountAtomic.trim();
            if (!isPositiveAtomicAmountInput(amount) || busy) return;
            quoteMutation.mutate(amount);
          }}
        >
          <label className="alex-field">
            <span>{t('quoteAmountLabel')}</span>
            <input
              type="text"
              name="withdrawal-amount-atomic"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={amountAtomic}
              disabled={busy}
              onChange={(event) => {
                setAmountAtomic(event.target.value);
                setError(null);
                setMessage(null);
                setAmbiguous(false);
              }}
            />
          </label>
          <button
            type="submit"
            className="lootra-btn lootra-btn--primary"
            disabled={!amountValid || busy || !eligible}
          >
            {quoteMutation.isPending ? t('quoteSubmitting') : t('quoteSubmit')}
          </button>
        </form>
      ) : null}

      {quote !== null && created === null ? (
        <div className="alex-stack-sm lootra-quote-locked" role="status" aria-live="polite">
          <p className="alex-meta">
            {t('withdrawalRequested')}:{' '}
            {isAtomicAmountString(quote.requestedAmountAtomic)
              ? formatAtomicAmountGrouped(quote.requestedAmountAtomic)
              : '—'}{' '}
            <span>{common('baseUnits')}</span>
          </p>
          <p className="alex-meta">
            {t('withdrawalFee')}:{' '}
            {isAtomicAmountString(quote.feeAmountAtomic)
              ? formatAtomicAmountGrouped(quote.feeAmountAtomic)
              : '—'}
          </p>
          <p className="alex-meta">
            {t('youReceive')}:{' '}
            {isAtomicAmountString(quote.netAmountAtomic)
              ? formatAtomicAmountGrouped(quote.netAmountAtomic)
              : '—'}
          </p>
          <p className="alex-meta">
            {t('quoteExpires')}: {quote.expiresAt}
          </p>
          {quote.status !== undefined ? (
            <p className="alex-meta">
              {t('quoteStatus')}: {quote.status}
            </p>
          ) : null}
          {quote.priorityReview ? (
            <p className="alex-meta">{t('priorityReview')}</p>
          ) : null}

          {quoteExpiredLocal ? (
            <p className="alex-banner alex-banner--warn" role="alert">
              {t('quoteExpired')}
            </p>
          ) : null}

          <div className="lootra-quote-actions">
            {quoteExpiredLocal ? (
              <button
                type="button"
                className="lootra-btn lootra-btn--primary"
                disabled={busy}
                onClick={() => {
                  clearQuoteLocal(quote);
                  setError(null);
                  setMessage(null);
                }}
              >
                {t('getNewQuote')}
              </button>
            ) : (
              <button
                type="button"
                className="lootra-btn lootra-btn--primary"
                disabled={busy}
                onClick={handleConfirmClick}
              >
                {confirmMutation.isPending ? t('confirmSubmitting') : t('quoteConfirm')}
              </button>
            )}
            <button
              type="button"
              className="lootra-btn lootra-btn--ghost"
              disabled={busy}
              onClick={() => cancelMutation.mutate(quote)}
            >
              {cancelMutation.isPending ? t('quoteCancelling') : t('cancelQuote')}
            </button>
          </div>

          {ambiguous ? (
            <div className="alex-stack-sm" role="alert">
              <p className="alex-banner alex-banner--warn">{t('confirmUncertain')}</p>
              <button
                type="button"
                className="lootra-btn lootra-btn--primary"
                disabled={busy}
                onClick={() => confirmMutation.mutate(quote)}
              >
                {common('retry')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {message !== null && created === null ? (
        <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error !== null && !ambiguous ? (
        <p className="alex-banner alex-banner--warn" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
