import { describe, expect, it } from 'vitest';

import {
  PRIMARY_CHANGE_REQUIRES_FRESH_PROOF,
  PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS,
  assertAcceptedMainnetNetworkMapping,
  assertTonPayoutAddressShape,
  assertWalletAppNameNotAuthority,
  primaryChangePolicyNotes,
} from '../src/phase21-mainnet-wallet-guards.js';
import { WalletDomainError } from '../src/errors.js';

describe('phase21 mainnet wallet guards', () => {
  it('accepts -239 for TON_MAINNET', () => {
    expect(() =>
      assertAcceptedMainnetNetworkMapping({
        acceptedNetworkCode: 'TON_MAINNET',
        tonConnectNetworkId: '-239',
      }),
    ).not.toThrow();
  });

  it('rejects -3 on Mainnet config', () => {
    expect(() =>
      assertAcceptedMainnetNetworkMapping({
        acceptedNetworkCode: 'TON_MAINNET',
        tonConnectNetworkId: '-3',
      }),
    ).toThrow(WalletDomainError);
  });

  it('rejects client network override', () => {
    expect(() =>
      assertAcceptedMainnetNetworkMapping({
        acceptedNetworkCode: 'TON_MAINNET',
        tonConnectNetworkId: '-239',
        clientNetworkId: '-3',
      }),
    ).toThrow(/CLIENT_NETWORK_OVERRIDE_REJECTED|Network is not accepted/);
  });

  it('allows matching client network id', () => {
    expect(() =>
      assertAcceptedMainnetNetworkMapping({
        acceptedNetworkCode: 'TON_MAINNET',
        tonConnectNetworkId: '-239',
        clientNetworkId: '-239',
      }),
    ).not.toThrow();
  });

  it('accepts raw and friendly TON addresses', () => {
    const raw = `0:${'ab'.repeat(32)}`;
    expect(assertTonPayoutAddressShape(raw)).toBe(raw);
    const friendly =
      'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
    expect(assertTonPayoutAddressShape(friendly)).toBe(friendly);
    const uq =
      'UQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
    expect(assertTonPayoutAddressShape(uq)).toBe(uq);
  });

  it('rejects TRON / EVM / Solana-ish shapes', () => {
    expect(() => assertTonPayoutAddressShape('TXYZabcdefghijklmnopqrstuvwxyz123456')).toThrow(
      WalletDomainError,
    );
    expect(() =>
      assertTonPayoutAddressShape('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0'),
    ).toThrow(WalletDomainError);
    expect(() =>
      assertTonPayoutAddressShape('4Nd1mYhe3KaxctnGhRSq2PRq2W4M2Y4M2Y4M2Y4M2Y4'),
    ).toThrow(WalletDomainError);
  });

  it('wallet app name is display-only note', () => {
    const note = assertWalletAppNameNotAuthority('Tonkeeper');
    expect(note).toContain('display-only');
    expect(note).toContain('never security authority');
  });

  it('documents primary-change fresh proof and cooldown', () => {
    expect(PRIMARY_CHANGE_REQUIRES_FRESH_PROOF).toBe(true);
    expect(PRIMARY_CHANGE_WITHDRAWAL_COOLDOWN_HOURS).toBe(24);
    expect(primaryChangePolicyNotes().join(' ')).toContain('24');
  });
});
