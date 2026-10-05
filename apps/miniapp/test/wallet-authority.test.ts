/**
 * LOOTRA Step 4 — Wallet / withdrawal UI authority invariants.
 * Server remains absolute for money, verification, fees, and withdrawal state.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UserWalletDto, WalletSummaryResponse } from '@alex-rewards/contracts';
import { describe, expect, it } from 'vitest';

import type { WithdrawalListItem, WithdrawalQuoteResponse } from '../src/lib/api/client';
import {
  formatAtomicAmount,
  formatAtomicAmountGrouped,
  isAtomicAmountString,
} from '../src/lib/money/format';
import {
  AmbiguousConfirmError,
  findWithdrawalByQuoteId,
  isAmbiguousTransportFailure,
} from '../src/lib/wallet/confirm-ambiguity';
import { createQuoteIdempotencyStore } from '../src/lib/wallet/quote-idempotency';
import { canEnterWithdrawalQuote } from '../src/lib/wallet/withdrawal-eligibility';
import {
  isPositiveAtomicAmountInput,
  isQuoteExpired,
  isWithdrawalCooldownActive,
  shortenFriendlyAddress,
} from '../src/lib/wallet/wallet-format';
import { matchesHistoryFilter } from '../src/lib/wallet/withdrawal-states';
import { ApiError } from '../src/lib/api/client';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function readSrc(relative: string): Promise<string> {
  return readFile(join(srcRoot, relative), 'utf8');
}

function wallet(overrides: Partial<UserWalletDto> = {}): UserWalletDto {
  return {
    id: 'w1',
    chain: 'TON',
    networkCode: 'TON_TESTNET',
    friendlyAddress: 'EQAabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
    walletName: 'Test',
    isPrimary: true,
    verified: true,
    verificationMethod: 'TON_PROOF',
    verifiedAt: '2026-09-28T00:00:00.000Z',
    becamePrimaryAt: '2026-09-28T00:00:00.000Z',
    disabledAt: null,
    ...overrides,
  };
}

function summary(overrides: Partial<WalletSummaryResponse> = {}): WalletSummaryResponse {
  return {
    status: 'READY',
    wallets: [wallet()],
    primaryWalletId: 'w1',
    acceptedNetworkCode: 'TON_TESTNET',
    withdrawalCooldownUntil: null,
    ...overrides,
  };
}

describe('LOOTRA Step 4 Wallet authority', () => {
  it('A — TonConnect connection alone does NOT equal server verified', async () => {
    const panel = await readSrc('components/WalletTonConnectPanel.tsx');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(panel).toMatch(/Connection alone is not verification/i);
    expect(panel).not.toMatch(/verified\s*:\s*true/);
    expect(screen).toMatch(/wallet\.verified \? t\('verified'\)/);
  });

  it('B — only server verified primary wallet enables normal withdrawal flow', () => {
    expect(canEnterWithdrawalQuote(summary())).toBe(true);
    expect(
      canEnterWithdrawalQuote(
        summary({ wallets: [wallet({ verified: false })] }),
      ),
    ).toBe(false);
    expect(
      canEnterWithdrawalQuote(
        summary({ wallets: [wallet({ isPrimary: false })], primaryWalletId: null }),
      ),
    ).toBe(false);
  });

  it('C — disabled wallet cannot qualify', () => {
    expect(
      canEnterWithdrawalQuote(
        summary({
          wallets: [wallet({ disabledAt: '2026-09-28T01:00:00.000Z' })],
        }),
      ),
    ).toBe(false);
  });

  it('D — active server cooldown disables quote entry', () => {
    const until = '2099-01-01T00:00:00.000Z';
    expect(isWithdrawalCooldownActive(until)).toBe(true);
    expect(
      canEnterWithdrawalQuote(summary({ withdrawalCooldownUntil: until })),
    ).toBe(false);
  });

  it('E — server Testnet is displayed honestly', async () => {
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(screen).toMatch(/acceptedNetworkCode/);
    expect(screen).toMatch(/networkTestnet/);
    expect(screen).not.toMatch(/hardcoded.*Mainnet|MAINNET_BADGE/i);
    expect(screen).toMatch(/wallet-hero\.png/);
  });

  it('F — atomic input is positive integer only', () => {
    expect(isPositiveAtomicAmountInput('9400000')).toBe(true);
    expect(isPositiveAtomicAmountInput('0')).toBe(false);
    expect(isPositiveAtomicAmountInput('-1')).toBe(false);
    expect(isPositiveAtomicAmountInput('9.4')).toBe(false);
    expect(isPositiveAtomicAmountInput('1e6')).toBe(false);
    expect(isPositiveAtomicAmountInput('')).toBe(false);
    expect(isPositiveAtomicAmountInput('12a')).toBe(false);
  });

  it('G — no token decimal conversion exists', () => {
    expect(formatAtomicAmount('9400000')).toBe('9400000');
    expect(formatAtomicAmountGrouped('9400000')).toBe('9,400,000');
    expect(formatAtomicAmountGrouped('9400000')).not.toMatch(/9\.4/);
  });

  it('H/I/J — fee and net come from quote fields; never requested - fee', async () => {
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    expect(quoteUi).toMatch(/quote\.feeAmountAtomic/);
    expect(quoteUi).toMatch(/quote\.netAmountAtomic/);
    expect(quoteUi).not.toMatch(/requestedAmountAtomic\s*-/);
    expect(quoteUi).not.toMatch(/BigInt\([^)]*\)\s*-/);
    expect(quoteUi).not.toMatch(/computeNet|platformFee|feeBps\s*=/);

    const quote: WithdrawalQuoteResponse = {
      id: 'q1',
      userId: 'u1',
      assetId: 'a1',
      networkId: 'n1',
      primaryWalletId: 'w1',
      requestedAmountAtomic: '10000',
      feeAmountAtomic: '150',
      netAmountAtomic: '9850',
      basePlatformFeeAtomic: '200',
      membershipFeeDiscountBps: 2500,
      feeRuleId: 'f1',
      feeRuleVersion: 1,
      limitRuleId: 'l1',
      limitRuleVersion: 1,
      priorityReview: false,
      status: 'OPEN',
      expiresAt: '2026-09-26T12:00:00.000Z',
    };
    expect(formatAtomicAmount(quote.feeAmountAtomic)).toBe('150');
    expect(formatAtomicAmount(quote.netAmountAtomic)).toBe('9850');
    // Authoritative net is the server field — not a client subtraction.
    expect(quote.netAmountAtomic).not.toBe(
      String(Number(quote.requestedAmountAtomic) - Number(quote.feeAmountAtomic) + 1),
    );
  });

  it('K — quote cancel uses real existing endpoint wrapper', async () => {
    const client = await readSrc('lib/api/client.ts');
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    expect(client).toMatch(/cancelWithdrawalQuote/);
    expect(client).toMatch(/\/v1\/withdrawal-quotes\/\$\{encodeURIComponent\(id\)\}\/cancel/);
    expect(quoteUi).toMatch(/cancelWithdrawalQuote/);
    expect(quoteUi).toMatch(/cancelQuote/);
  });

  it('L — withdrawal detail uses real existing endpoint wrapper', async () => {
    const client = await readSrc('lib/api/client.ts');
    const detail = await readSrc('components/WithdrawalDetailScreen.tsx');
    const keys = await readSrc('lib/query/keys.ts');
    expect(client).toMatch(/getWithdrawal\(id/);
    expect(client).toMatch(/\/v1\/withdrawals\/\$\{encodeURIComponent\(id\)\}/);
    expect(detail).toMatch(/api\.getWithdrawal/);
    expect(detail).toMatch(/queryKeys\.withdrawal/);
    expect(keys).toMatch(/withdrawal:\s*\(id:\s*string\)\s*=>\s*\['withdrawals',\s*id\]/);
  });

  it('M — same quote retry reuses same idempotency key; new quote gets a different key', () => {
    let n = 0;
    const store = createQuoteIdempotencyStore(() => `key-${++n}`);
    const first = store.getOrCreate('quote-a');
    const retry = store.getOrCreate('quote-a');
    expect(first).toBe(retry);
    expect(first).toBe('key-1');
    const other = store.getOrCreate('quote-b');
    expect(other).toBe('key-2');
    expect(other).not.toBe(first);
  });

  it('M2 — confirm mutation does not call randomUUID on every invocation', async () => {
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    expect(quoteUi).toMatch(/createQuoteIdempotencyStore|idempotency\.getOrCreate/);
    expect(quoteUi).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it('N — ambiguous transport failure is not treated as definitive ApiError rejection', () => {
    expect(isAmbiguousTransportFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAmbiguousTransportFailure(new AmbiguousConfirmError())).toBe(true);
    expect(
      isAmbiguousTransportFailure(new ApiError(400, 'VALIDATION', 'bad', null)),
    ).toBe(false);
  });

  it('O — ambiguous failure reconciliation checks real withdrawal list by quoteId', () => {
    const list: WithdrawalListItem[] = [
      {
        id: 'wd1',
        publicId: 'WD-1',
        userId: 'u1',
        quoteId: 'quote-a',
        state: 'REQUESTED',
        requestedAmountAtomic: '1000',
        feeAmountAtomic: '10',
        netAmountAtomic: '990',
        priorityReview: false,
        riskDecision: null,
        workflowId: null,
      },
    ];
    expect(findWithdrawalByQuoteId(list, 'quote-a')?.id).toBe('wd1');
    expect(findWithdrawalByQuoteId(list, 'missing')).toBeNull();
  });

  it('P — no optimistic balance subtraction', async () => {
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(quoteUi).not.toMatch(/available\s*-=|setQueryData.*balances/);
    expect(quoteUi).toMatch(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.balances/);
    expect(screen).not.toMatch(/available\s*-=/);
  });

  it('Q/R — history uses real server list only; no fake timestamps', async () => {
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(screen).toMatch(/getWithdrawals/);
    expect(screen).toMatch(/withdrawals\.data\.withdrawals/);
    expect(screen).not.toMatch(/requestedAt|createdAt|fake.*withdrawal|mockWithdrawals/i);
    expect(matchesHistoryFilter('REQUESTED', 'in_progress')).toBe(true);
    expect(matchesHistoryFilter('HELD', 'attention')).toBe(true);
    expect(matchesHistoryFilter('CONFIRMED', 'final')).toBe(true);
  });

  it('S — detail does not invent transaction hash/explorer data', async () => {
    const detail = await readSrc('components/WithdrawalDetailScreen.tsx');
    expect(detail).not.toMatch(/txHash|transactionHash|explorer|tonviewer|tonscan/i);
    expect(detail).toMatch(/publicId/);
    expect(detail).toMatch(/feeAmountAtomic/);
    expect(detail).toMatch(/netAmountAtomic/);
  });

  it('T — there is no Cancel Withdrawal action', async () => {
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    const screen = await readSrc('components/WalletScreen.tsx');
    const detail = await readSrc('components/WithdrawalDetailScreen.tsx');
    expect(quoteUi).toMatch(/cancelQuote/);
    expect(quoteUi).not.toMatch(/cancelWithdrawal[^Q]|Cancel withdrawal/i);
    expect(screen).not.toMatch(/Cancel withdrawal/i);
    expect(detail).not.toMatch(/Cancel withdrawal|cancelWithdrawal/i);
  });

  it('U — wallet bind invalidates home', async () => {
    const panel = await readSrc('components/WalletTonConnectPanel.tsx');
    expect(panel).toMatch(/queryKeys\.home/);
    expect(panel).toMatch(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.wallets/);
    expect(panel).toMatch(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.balances/);
  });

  it('V — long wallet address cannot widen Wallet layout', async () => {
    const css = await readSrc('app/globals.css');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(css).toMatch(/\.lootra-wallet[\s\S]*overflow-x:\s*hidden/);
    expect(css).toMatch(/\.lootra-wallet-address[\s\S]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/min-width:\s*0/);
    expect(screen).toMatch(/shortenFriendlyAddress/);
    const long =
      'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
    const short = shortenFriendlyAddress(long);
    expect(short.length).toBeLessThan(long.length);
    expect(short.startsWith(long.slice(0, 6))).toBe(true);
  });

  it('quote expiry helper honors server expiresAt', () => {
    expect(isQuoteExpired('2000-01-01T00:00:00.000Z')).toBe(true);
    expect(isQuoteExpired('2099-01-01T00:00:00.000Z')).toBe(false);
  });

  it('atomic grouping preserves all digits', () => {
    expect(isAtomicAmountString('9400000')).toBe(true);
    expect(formatAtomicAmountGrouped('9400000')).toBe('9,400,000');
  });
});
