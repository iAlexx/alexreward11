'use client';

import { useTonConnectUI } from '@tonconnect/ui-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';

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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bindMutation = useMutation({
    mutationFn: async () => {
      setMessage(null);
      setError(null);

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

      const wallet = await tonConnectUI.connectWallet();
      const tonProofItem = wallet.connectItems?.tonProof;
      if (tonProofItem === undefined) {
        throw new Error('PROOF_MISSING');
      }
      if ('error' in tonProofItem) {
        throw new Error('PROOF_REJECTED');
      }

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
      setMessage(t('bindSuccess'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.wallets });
      await queryClient.invalidateQueries({ queryKey: queryKeys.balances });
    },
    onError: (err: unknown) => {
      setMessage(null);
      if (
        err instanceof Error &&
        (err.message === 'PROOF_MISSING' || err.message === 'PROOF_REJECTED')
      ) {
        setError(t('bindProofMissing'));
        return;
      }
      if (err instanceof ApiError) {
        if (err.status === 429) setError(t('bindRateLimited'));
        else setError(t('bindFailed'));
        return;
      }
      setError(t('bindFailed'));
    },
    onSettled: () => {
      tonConnectUI.setConnectRequestParameters(null);
    },
  });

  return (
    <div className="alex-stack-sm">
      <p className="alex-muted">{t('connectHelp')}</p>
      <button
        type="button"
        className="alex-button"
        disabled={bindMutation.isPending}
        onClick={() => bindMutation.mutate()}
      >
        {bindMutation.isPending ? t('bindInProgress') : t('verifyOwnership')}
      </button>
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
    </div>
  );
}
