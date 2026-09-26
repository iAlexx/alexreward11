'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError, type WithdrawalQuoteResponse } from '../lib/api/client';
import { formatAtomicAmount, isAtomicAmountString } from '../lib/money/format';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';

/**
 * Withdrawal quote + confirm UI.
 *
 * Fees, net, and expiry are displayed exactly as returned by POST /v1/withdrawals/quote.
 * The Mini App never computes platform fees or net amounts locally.
 */
export function WalletWithdrawalQuote() {
  const t = useTranslations('wallet');
  const common = useTranslations('common');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [amountAtomic, setAmountAtomic] = useState('');
  const [quote, setQuote] = useState<WithdrawalQuoteResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quoteMutation = useMutation({
    mutationFn: async (amount: string) => api.createWithdrawalQuote(amount),
    onSuccess: (data) => {
      setError(null);
      setMessage(null);
      setQuote(data);
    },
    onError: (err: unknown) => {
      setQuote(null);
      setMessage(null);
      if (err instanceof ApiError) setError(t('quoteFailed'));
      else setError(t('quoteFailed'));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (activeQuote: WithdrawalQuoteResponse) => {
      const idempotencyKey = globalThis.crypto.randomUUID();
      return api.createWithdrawal({
        quoteId: activeQuote.id,
        idempotencyKey,
      });
    },
    onSuccess: async () => {
      setQuote(null);
      setAmountAtomic('');
      setError(null);
      setMessage(t('confirmSuccess'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.withdrawals });
      await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
    onError: (err: unknown) => {
      setMessage(null);
      if (err instanceof ApiError) setError(t('confirmFailed'));
      else setError(t('confirmFailed'));
    },
  });

  const amountValid = isAtomicAmountString(amountAtomic.trim()) && amountAtomic.trim() !== '';

  return (
    <section className="alex-card" aria-label={t('quoteTitle')}>
      <h2 className="alex-title-sm">{t('quoteTitle')}</h2>
      <p className="alex-muted">{t('quoteHelp')}</p>
      <form
        className="alex-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const amount = amountAtomic.trim();
          if (!isAtomicAmountString(amount) || quoteMutation.isPending) return;
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
            disabled={quoteMutation.isPending || confirmMutation.isPending}
            onChange={(event) => {
              setAmountAtomic(event.target.value);
              setQuote(null);
              setError(null);
              setMessage(null);
            }}
          />
        </label>
        <button
          type="submit"
          className="alex-button"
          disabled={!amountValid || quoteMutation.isPending || confirmMutation.isPending}
        >
          {quoteMutation.isPending ? t('quoteSubmitting') : t('quoteSubmit')}
        </button>
      </form>

      {quote !== null ? (
        <div className="alex-stack-sm" role="status">
          <p className="alex-meta">
            {t('withdrawalRequested')}:{' '}
            {isAtomicAmountString(quote.requestedAmountAtomic)
              ? formatAtomicAmount(quote.requestedAmountAtomic)
              : '—'}{' '}
            <span className="alex-meta">{common('baseUnits')}</span>
          </p>
          <p className="alex-meta">
            {t('withdrawalFee')}:{' '}
            {isAtomicAmountString(quote.feeAmountAtomic)
              ? formatAtomicAmount(quote.feeAmountAtomic)
              : '—'}
          </p>
          <p className="alex-meta">
            {t('withdrawalNet')}:{' '}
            {isAtomicAmountString(quote.netAmountAtomic)
              ? formatAtomicAmount(quote.netAmountAtomic)
              : '—'}
          </p>
          <p className="alex-meta">
            {t('quoteExpires')}: {quote.expiresAt}
          </p>
          <button
            type="button"
            className="alex-button"
            disabled={confirmMutation.isPending}
            onClick={() => confirmMutation.mutate(quote)}
          >
            {confirmMutation.isPending ? t('confirmSubmitting') : t('quoteConfirm')}
          </button>
        </div>
      ) : null}

      {message !== null ? (
        <p className="alex-banner alex-banner--ok" role="status">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <p className="alex-banner alex-banner--warn" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
