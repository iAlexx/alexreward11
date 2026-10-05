'use client';

import { useTonConnectUI } from '@tonconnect/ui-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';

type TonUiPhase =
  | 'IDLE'
  | 'REQUESTING_CHALLENGE'
  | 'WAITING_FOR_WALLET'
  | 'VERIFYING_PROOF'
  | 'VERIFIED'
  | 'REJECTED'
  | 'RATE_LIMITED'
  | 'ERROR';

function mapBindError(err: unknown, t: ReturnType<typeof useTranslations<'wallet'>>): {
  phase: TonUiPhase;
  message: string;
} {
  if (err instanceof Error && (err.message === 'PROOF_MISSING' || err.message === 'PROOF_REJECTED')) {
    return { phase: 'REJECTED', message: t('bindProofMissing') };
  }
  if (err instanceof ApiError) {
    if (err.status === 429 || err.code === 'RATE_LIMITED') {
      return { phase: 'RATE_LIMITED', message: t('bindRateLimited') };
    }
    const code = err.code;
    const key = `bindError_${code}` as
      | 'bindError_REPLAY'
      | 'bindError_CHALLENGE_CONSUMED'
      | 'bindError_CHALLENGE_NOT_FOUND'
      | 'bindError_CHALLENGE_EXPIRED'
      | 'bindError_CHALLENGE_INVALIDATED'
      | 'bindError_INVALID_PROOF'
      | 'bindError_INVALID_DOMAIN'
      | 'bindError_INVALID_NETWORK'
      | 'bindError_INVALID_WALLET'
      | 'bindError_INVALID_ADDRESS';
    if (
      code === 'REPLAY' ||
      code === 'CHALLENGE_CONSUMED' ||
      code === 'CHALLENGE_NOT_FOUND' ||
      code === 'CHALLENGE_EXPIRED' ||
      code === 'CHALLENGE_INVALIDATED' ||
      code === 'INVALID_PROOF' ||
      code === 'INVALID_DOMAIN' ||
      code === 'INVALID_NETWORK' ||
      code === 'INVALID_WALLET' ||
      code === 'INVALID_ADDRESS'
    ) {
      return { phase: 'REJECTED', message: t(key) };
    }
    return { phase: 'ERROR', message: t('bindFailed') };
  }
  return { phase: 'ERROR', message: t('bindFailed') };
}

/**
 * TON Connect ownership proof panel.
 *
 * Challenge is server-issued; bind is decided entirely by POST /v1/wallets/ton-proof/bind.
 * A successful wallet connection is never treated as verified on the client.
 */
export function WalletTonConnectPanel() {
  const t = useTranslations('wallet');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [tonConnectUI] = useTonConnectUI();
  const [phase, setPhase] = useState<TonUiPhase>('IDLE');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bindMutation = useMutation({
    mutationFn: async () => {
      setMessage(null);
      setError(null);
      setPhase('REQUESTING_CHALLENGE');

      if (tonConnectUI.connected) {
        await tonConnectUI.disconnect();
      }

      tonConnectUI.setConnectRequestParameters({ state: 'loading' });
      const challenge = await api.createTonProofChallenge();
      tonConnectUI.setConnectionNetwork(challenge.tonConnectNetworkId);
      tonConnectUI.setConnectRequestParameters({
        state: 'ready',
        value: { tonProof: challenge.challenge },
      });

      setPhase('WAITING_FOR_WALLET');
      setMessage(t('confirmInWallet'));

      const wallet = await tonConnectUI.connectWallet();
      const tonProofItem = wallet.connectItems?.tonProof;
      if (tonProofItem === undefined) {
        throw new Error('PROOF_MISSING');
      }
      if ('error' in tonProofItem) {
        throw new Error('PROOF_REJECTED');
      }

      setPhase('VERIFYING_PROOF');
      setMessage(t('verifyingOwnership'));

      // Connection alone is not verification — only the server bind response is authority.
      await api.bindTonProofWallet({
        account: {
          address: wallet.account.address,
          network: String(wallet.account.chain),
          ...(wallet.account.publicKey !== undefined
            ? { publicKey: wallet.account.publicKey }
            : {}),
          ...(wallet.account.walletStateInit !== undefined
            ? { walletStateInit: wallet.account.walletStateInit }
            : {}),
        },
        proof: {
          timestamp: tonProofItem.proof.timestamp,
          domain: tonProofItem.proof.domain,
          payload: tonProofItem.proof.payload,
          signature: tonProofItem.proof.signature,
          ...(wallet.account.walletStateInit !== undefined
            ? { stateInit: wallet.account.walletStateInit }
            : {}),
        },
        walletName: wallet.device?.appName ?? null,
      });
    },
    onSuccess: async () => {
      setError(null);
      setPhase('VERIFIED');
      setMessage(t('bindSuccess'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.wallets });
      await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
    onError: (err: unknown) => {
      setMessage(null);
      const mapped = mapBindError(err, t);
      setPhase(mapped.phase);
      setError(mapped.message);
    },
    onSettled: () => {
      tonConnectUI.setConnectRequestParameters(null);
    },
  });

  const phaseHint =
    phase === 'REQUESTING_CHALLENGE'
      ? t('preparingVerification')
      : phase === 'WAITING_FOR_WALLET'
        ? t('confirmInWallet')
        : phase === 'VERIFYING_PROOF'
          ? t('verifyingOwnership')
          : null;

  return (
    <div className="alex-stack-sm lootra-ton-panel">
      <p className="alex-muted">{t('connectHelp')}</p>
      <button
        type="button"
        className="lootra-btn lootra-btn--primary"
        disabled={bindMutation.isPending}
        onClick={() => bindMutation.mutate()}
      >
        {bindMutation.isPending ? t('bindInProgress') : t('verifyOwnership')}
      </button>
      {phaseHint !== null && error === null ? (
        <p className="alex-banner" role="status" aria-live="polite">
          {phaseHint}
        </p>
      ) : null}
      {message !== null && phase === 'VERIFIED' ? (
        <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <p className="alex-banner alex-banner--warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
