/**
 * Wallet read models and ton_proof binding contracts (Phase 12).
 *
 * The server chooses the accepted network and the proof domain; neither is ever taken from
 * the client. Only proven (`TON_PROOF`) wallets are payout-eligible, and no private key
 * material exists anywhere in these shapes.
 */

import type { ServerDomainAvailability } from './common.js';

export type WalletVerificationMethodDto = 'TON_PROOF' | 'ADMIN_MANUAL';

export interface UserWalletDto {
  readonly id: string;
  readonly chain: string;
  readonly networkCode: string;
  readonly friendlyAddress: string;
  readonly walletName: string | null;
  readonly isPrimary: boolean;
  readonly verified: boolean;
  readonly verificationMethod: WalletVerificationMethodDto | null;
  readonly verifiedAt: string | null;
  readonly becamePrimaryAt: string | null;
  readonly disabledAt: string | null;
}

export interface WalletSummaryResponse {
  readonly status: ServerDomainAvailability;
  readonly wallets: readonly UserWalletDto[];
  readonly primaryWalletId: string | null;
  readonly acceptedNetworkCode: string;
  /** Server-side payout cooldown after a primary wallet change, when one is active. */
  readonly withdrawalCooldownUntil: string | null;
}

export interface TonProofChallengeResponse {
  readonly challenge: string;
  readonly expiresAt: string;
  readonly networkCode: string;
  readonly tonConnectNetworkId: string;
  readonly expectedDomain: string;
}

export interface TonProofBindRequest {
  readonly account: {
    readonly address: string;
    readonly network: string;
    readonly publicKey?: string;
    readonly walletStateInit?: string;
  };
  readonly proof: {
    readonly timestamp: number;
    readonly domain: { readonly lengthBytes: number; readonly value: string };
    readonly payload: string;
    readonly signature: string;
    readonly stateInit?: string;
  };
  /** Display-only label; never security evidence. */
  readonly walletName?: string | null;
}

export interface TonProofBindResponse {
  readonly walletId: string;
  readonly friendlyAddress: string;
  readonly verified: true;
  readonly verificationMethod: 'TON_PROOF';
  readonly verifiedAt: string;
  readonly isPrimary: boolean;
  readonly becamePrimary: boolean;
}
