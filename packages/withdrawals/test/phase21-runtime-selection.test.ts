import { describe, expect, it } from 'vitest';

import {
  assertWithdrawalAuthorityMatchesNetwork,
  selectWithdrawalPayoutAuthority,
} from '../src/phase21-runtime-selection.js';

describe('phase21 runtime selection', () => {
  it('defaults to Phase10 Testnet when Mainnet gate is off', () => {
    expect(
      selectWithdrawalPayoutAuthority({
        phase21MainnetEnabled: false,
        withdrawalNetworkCode: 'TON_TESTNET',
      }),
    ).toBe('PHASE10_TESTNET');
  });

  it('selects Phase21 Mainnet only when explicitly enabled', () => {
    expect(
      selectWithdrawalPayoutAuthority({
        phase21MainnetEnabled: true,
        withdrawalNetworkCode: 'TON_MAINNET',
      }),
    ).toBe('PHASE21_MAINNET');
  });

  it('rejects cross-network authority mismatch', () => {
    expect(() =>
      assertWithdrawalAuthorityMatchesNetwork({
        authority: 'PHASE10_TESTNET',
        withdrawalNetworkCode: 'TON_MAINNET',
      }),
    ).toThrow(/forbids MAINNET/);

    expect(() =>
      assertWithdrawalAuthorityMatchesNetwork({
        authority: 'PHASE21_MAINNET',
        withdrawalNetworkCode: 'TON_TESTNET',
      }),
    ).toThrow(/requires WITHDRAWAL_NETWORK_CODE=TON_MAINNET/);
  });
});
