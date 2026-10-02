/**
 * Explicit Phase 10 Testnet vs Phase 21 Mainnet payout authority selection.
 * Never inferred from NODE_ENV, branch, or Railway environment name.
 */
export type WithdrawalPayoutAuthority = 'PHASE10_TESTNET' | 'PHASE21_MAINNET';

export interface WithdrawalPayoutAuthorityInput {
  readonly phase21MainnetEnabled: boolean;
  readonly withdrawalNetworkCode: string;
}

export function selectWithdrawalPayoutAuthority(
  input: WithdrawalPayoutAuthorityInput,
): WithdrawalPayoutAuthority {
  if (input.phase21MainnetEnabled === true) {
    return 'PHASE21_MAINNET';
  }
  return 'PHASE10_TESTNET';
}

export function assertWithdrawalAuthorityMatchesNetwork(input: {
  readonly authority: WithdrawalPayoutAuthority;
  readonly withdrawalNetworkCode: string;
}): void {
  const code = input.withdrawalNetworkCode.trim().toUpperCase();
  if (input.authority === 'PHASE21_MAINNET' && code !== 'TON_MAINNET') {
    throw new Error(
      `PHASE21_MAINNET authority requires WITHDRAWAL_NETWORK_CODE=TON_MAINNET (observed ${code})`,
    );
  }
  if (input.authority === 'PHASE10_TESTNET' && code.includes('MAINNET')) {
    throw new Error(
      `PHASE10_TESTNET authority forbids MAINNET withdrawal network code (observed ${code})`,
    );
  }
}
