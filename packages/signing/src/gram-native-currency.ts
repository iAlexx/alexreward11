/**
 * Phase 21 — native currency display/canonical naming for TON chain.
 *
 * Chain remains TON / TON_MAINNET / globalId -239.
 * Canonical native currency display = Gram (GRAM), 9 decimals, atomic unit = nanogram.
 * Do NOT rename TON_MAINNET → GRAM_MAINNET.
 * Legacy ledger account type codes (HOT_WALLET_TON_ASSET, TON_NETWORK_FEE_EXPENSE)
 * remain LEGACY_INTERNAL_IDENTIFIER — never rewrite migrations.
 */
export const GRAM_SYMBOL = 'GRAM' as const;
export const GRAM_DISPLAY_NAME = 'Gram' as const;
export const GRAM_DECIMALS = 9 as const;
/** 1 GRAM = 1_000_000_000 nanogram. */
export const NANOGRAM_PER_GRAM = 1_000_000_000n;
export const PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC = 1n;

/** Provider / user-facing aliases that normalize to GRAM in native-currency context only. */
export const NATIVE_CURRENCY_ALIASES_TO_GRAM = [
  'GRAM',
  'Gram',
  'TON',
  'Ton',
  'Toncoin',
  'toncoin',
] as const;

export type NativeCurrencyNamingClass =
  | 'CANONICAL_NATIVE_DISPLAY'
  | 'CHAIN_NETWORK_AUTHORITY'
  | 'PROVIDER_ALIAS_NORMALIZE_TO_GRAM'
  | 'LEGACY_INTERNAL_IDENTIFIER'
  | 'TESTNET_HISTORICAL_FIXTURE'
  | 'PAYOUT_ASSET_UNCHANGED';

export function nanogramToGramString(nanogram: bigint): string {
  if (nanogram < 0n) {
    throw new Error('nanogram amount must be non-negative');
  }
  const whole = nanogram / NANOGRAM_PER_GRAM;
  const frac = nanogram % NANOGRAM_PER_GRAM;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(GRAM_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export function gramToNanogram(gramWhole: bigint, nanogramFraction = 0n): bigint {
  if (gramWhole < 0n || nanogramFraction < 0n || nanogramFraction >= NANOGRAM_PER_GRAM) {
    throw new Error('invalid GRAM / nanogram components');
  }
  return gramWhole * NANOGRAM_PER_GRAM + nanogramFraction;
}

/**
 * Normalize provider/native aliases to canonical GRAM.
 * USDT and other jettons are unchanged (returns null = not a native alias).
 */
export function normalizeNativeCurrencyAlias(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (upper === 'USDT' || upper === 'AALEX') return null;
  if (
    upper === 'GRAM' ||
    upper === 'TON' ||
    upper === 'TONCOIN' ||
    trimmed === 'Ton' ||
    trimmed === 'Toncoin'
  ) {
    return GRAM_SYMBOL;
  }
  return null;
}

export function classifyNativeCurrencyIdentifier(id: string): NativeCurrencyNamingClass {
  switch (id) {
    case 'GRAM':
    case 'Gram':
      return 'CANONICAL_NATIVE_DISPLAY';
    case 'TON_MAINNET':
    case 'TON_TESTNET':
    case 'TON':
    case 'chain=TON':
      return 'CHAIN_NETWORK_AUTHORITY';
    case 'Toncoin':
    case 'toncoin':
      return 'PROVIDER_ALIAS_NORMALIZE_TO_GRAM';
    case 'HOT_WALLET_TON_ASSET':
    case 'TON_NETWORK_FEE_EXPENSE':
    case 'attachedTonAtomic':
    case 'forwardTonAtomic':
      return 'LEGACY_INTERNAL_IDENTIFIER';
    case 'LOCAL_FIXTURE_SYMBOL_TON':
      return 'TESTNET_HISTORICAL_FIXTURE';
    case 'USDT':
      return 'PAYOUT_ASSET_UNCHANGED';
    default:
      if (id.toUpperCase() === 'TON' || id.toUpperCase() === 'TONCOIN') {
        return 'PROVIDER_ALIAS_NORMALIZE_TO_GRAM';
      }
      return 'LEGACY_INTERNAL_IDENTIFIER';
  }
}
