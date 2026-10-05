import type { UserWalletDto, WalletSummaryResponse } from '@alex-rewards/contracts';

export type HomeWalletCtaKind = 'connect' | 'withdraw' | 'open';

export interface HomeWalletCta {
  readonly kind: HomeWalletCtaKind;
  /** Always /wallet in Step 2 — withdrawal starts on Wallet, not Home. */
  readonly href: '/wallet';
}

/** Qualifying payout destination: primary + verified + not disabled. */
export function isVerifiedPrimaryWallet(wallet: UserWalletDto): boolean {
  return wallet.isPrimary && wallet.verified && wallet.disabledAt === null;
}

export function findVerifiedPrimaryWallet(
  summary: WalletSummaryResponse | null | undefined,
): UserWalletDto | null {
  if (summary === null || summary === undefined) return null;
  if (summary.status !== 'READY') return null;
  return summary.wallets.find(isVerifiedPrimaryWallet) ?? null;
}

/**
 * Balance Hero CTA from wallet query truth.
 * Query failure / unread summary → conservative Open Wallet (never assume verified).
 */
export function resolveHomeWalletCta(input: {
  readonly wallets: WalletSummaryResponse | null | undefined;
  readonly walletsQueryFailed: boolean;
  readonly walletsQueryPending: boolean;
}): HomeWalletCta {
  if (input.walletsQueryFailed || input.walletsQueryPending) {
    return { kind: 'open', href: '/wallet' };
  }
  if (findVerifiedPrimaryWallet(input.wallets) !== null) {
    return { kind: 'withdraw', href: '/wallet' };
  }
  return { kind: 'connect', href: '/wallet' };
}
