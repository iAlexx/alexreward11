import { describe, expect, it } from 'vitest';

import {
  GRAM_DECIMALS,
  GRAM_SYMBOL,
  NANOGRAM_PER_GRAM,
  PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
  classifyNativeCurrencyIdentifier,
  gramToNanogram,
  nanogramToGramString,
  normalizeNativeCurrencyAlias,
} from '../src/gram-native-currency.js';

describe('gram native currency', () => {
  it('exports Gram canonical constants', () => {
    expect(GRAM_SYMBOL).toBe('GRAM');
    expect(GRAM_DECIMALS).toBe(9);
    expect(NANOGRAM_PER_GRAM).toBe(1_000_000_000n);
    expect(PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC).toBe(1n);
  });

  it('converts nanogram <-> gram string', () => {
    expect(nanogramToGramString(0n)).toBe('0');
    expect(nanogramToGramString(1_000_000_000n)).toBe('1');
    expect(nanogramToGramString(1_500_000_000n)).toBe('1.5');
    expect(nanogramToGramString(1n)).toBe('0.000000001');
    expect(gramToNanogram(1n)).toBe(1_000_000_000n);
    expect(gramToNanogram(0n, 1n)).toBe(1n);
  });

  it('rejects negative nanogram', () => {
    expect(() => nanogramToGramString(-1n)).toThrow(/non-negative/);
  });

  it('normalizes provider aliases to GRAM; leaves USDT alone', () => {
    expect(normalizeNativeCurrencyAlias('TON')).toBe('GRAM');
    expect(normalizeNativeCurrencyAlias('Toncoin')).toBe('GRAM');
    expect(normalizeNativeCurrencyAlias('GRAM')).toBe('GRAM');
    expect(normalizeNativeCurrencyAlias('USDT')).toBeNull();
    expect(normalizeNativeCurrencyAlias('aalex')).toBeNull();
  });

  it('classifies naming classes', () => {
    expect(classifyNativeCurrencyIdentifier('GRAM')).toBe('CANONICAL_NATIVE_DISPLAY');
    expect(classifyNativeCurrencyIdentifier('TON_MAINNET')).toBe('CHAIN_NETWORK_AUTHORITY');
    expect(classifyNativeCurrencyIdentifier('Toncoin')).toBe('PROVIDER_ALIAS_NORMALIZE_TO_GRAM');
    expect(classifyNativeCurrencyIdentifier('HOT_WALLET_TON_ASSET')).toBe(
      'LEGACY_INTERNAL_IDENTIFIER',
    );
    expect(classifyNativeCurrencyIdentifier('USDT')).toBe('PAYOUT_ASSET_UNCHANGED');
  });
});
