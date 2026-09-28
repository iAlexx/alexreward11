import type { WalletSummaryResponse } from '@alex-rewards/contracts';

import { findVerifiedPrimaryWallet } from '../home/home-wallet-cta';
import { isWithdrawalCooldownActive } from './wallet-format';

/**
 * Presentation eligibility for showing the quote entry UI.
 * Does NOT recreate full withdrawal-engine policy — server still decides all money rules.
 */
export function canEnterWithdrawalQuote(
  wallets: WalletSummaryResponse | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (wallets === null || wallets === undefined) return false;
  if (wallets.status !== 'READY') return false;
  if (findVerifiedPrimaryWallet(wallets) === null) return false;
  if (isWithdrawalCooldownActive(wallets.withdrawalCooldownUntil, nowMs)) return false;
  return true;
}
