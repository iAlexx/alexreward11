import type { StateInit } from '@ton/core';

/** A wallet needs StateInit only for its first (seqno zero) External-In message. */
export function walletStateInitForSeqno(
  seqno: number,
  walletStateInit: StateInit,
): StateInit | undefined {
  return seqno === 0 ? walletStateInit : undefined;
}
