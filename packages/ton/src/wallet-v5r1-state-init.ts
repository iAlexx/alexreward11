import type { StateInit } from '@ton/core';

/**
 * First External-In StateInit is bound to proven uninitialized account lifecycle,
 * not seqno=0 alone. Active wallets (including active+seqno=0) never get StateInit.
 */
export function walletStateInitForSeqno(
  seqno: number,
  walletStateInit: StateInit,
  provenAccountStatus: 'uninit' | 'active',
): StateInit | undefined {
  if (provenAccountStatus !== 'uninit') {
    return undefined;
  }
  return seqno === 0 ? walletStateInit : undefined;
}
