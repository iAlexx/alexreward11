/**
 * Phase 17 Step 2 — pure formatting helpers for public payout publication.
 * Bigint-only amount math. HTTPS explorer URLs only.
 */

import { WithdrawalDomainError } from './errors.js';

const DIGITS = /^\d+$/;

/**
 * Format atomic integer string with `decimals` fractional digits (bigint only).
 * Example: ("1900000", 6) -> "1.900000"
 */
export function formatAtomicAmount(amountAtomic: string, decimals: number): string {
  const trimmed = amountAtomic.trim();
  if (!DIGITS.test(trimmed)) {
    throw new WithdrawalDomainError('VALIDATION', 'amountAtomic must be a non-negative integer string');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new WithdrawalDomainError('VALIDATION', 'decimals must be an integer 0..18');
  }
  const value = BigInt(trimmed);
  if (decimals === 0) {
    return value.toString(10);
  }
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString(10).padStart(decimals, '0');
  return `${whole.toString(10)}.${fracStr}`;
}

/**
 * Join explorer base URL with chain tx reference. Requires https; rejects http.
 */
export function buildExplorerUrl(baseUrl: string, chainTxReference: string): string {
  const base = baseUrl.trim();
  const ref = chainTxReference.trim();
  if (base === '' || ref === '') {
    throw new WithdrawalDomainError('CONFIG', 'explorer base URL and chain_tx_reference are required');
  }
  if (ref.includes('://') || ref.includes('\\') || ref.includes('..')) {
    throw new WithdrawalDomainError('VALIDATION', 'chain_tx_reference must be a path/id segment');
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new WithdrawalDomainError('CONFIG', 'public_explorer_base_url is not a valid URL', {
      details: { baseUrl: base },
    });
  }
  if (url.protocol !== 'https:') {
    throw new WithdrawalDomainError('CONFIG', 'public_explorer_base_url must use https', {
      details: { protocol: url.protocol },
    });
  }
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  const segment = ref.replace(/^\/+/, '');
  url.pathname = `${basePath}${segment}`.replace(/\/+/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** UTC calendar date YYYY-MM-DD from confirmed_at. */
export function formatConfirmedUtcDate(confirmedAt: Date): string {
  if (!(confirmedAt instanceof Date) || Number.isNaN(confirmedAt.getTime())) {
    throw new WithdrawalDomainError('VALIDATION', 'confirmedAt must be a valid Date');
  }
  const y = confirmedAt.getUTCFullYear();
  const m = String(confirmedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(confirmedAt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
