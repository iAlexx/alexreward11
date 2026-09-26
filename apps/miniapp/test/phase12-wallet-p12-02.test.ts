/**
 * Phase 12 remediation P12-02 — Wallet screen authority invariants.
 *
 * Balances, TON Connect bind, and withdrawal quotes must stay server-authored.
 * Connection is never client-declared verified; fees are never computed locally.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { UserBalancesResponse } from '@alex-rewards/contracts';

import type { WithdrawalQuoteResponse } from '../src/lib/api/client';
import { formatAtomicAmount, isAtomicAmountString } from '../src/lib/money/format';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function readSrc(relative: string): Promise<string> {
  return readFile(join(srcRoot, relative), 'utf8');
}

describe('P12-02 Wallet balances', () => {
  it('renders Available/Pending/Reserved from server buckets only', async () => {
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(screen).toMatch(/balances\.data\.available/);
    expect(screen).toMatch(/balances\.data\.pending/);
    expect(screen).toMatch(/balances\.data\.reserved/);
    expect(screen).toMatch(/balanceAvailable/);
    expect(screen).toMatch(/balancePending/);
    expect(screen).toMatch(/balanceReserved/);
    expect(screen).toMatch(/getBalances/);
  });

  it('formats atomic-string balances without inventing subunit conversion', () => {
    const server: UserBalancesResponse = {
      asOf: '2026-09-26T00:00:00.000Z',
      available: { state: 'READY', amountAtomic: '1000', assetSymbol: 'USDT', assetId: 'a' },
      pending: { state: 'READY', amountAtomic: '250', assetSymbol: 'USDT', assetId: 'a' },
      reserved: { state: 'READY', amountAtomic: '75', assetSymbol: 'USDT', assetId: 'a' },
      lifetimeEarned: { state: 'READY', amountAtomic: '1325', assetSymbol: 'USDT', assetId: 'a' },
    };
    expect(isAtomicAmountString(server.available.amountAtomic)).toBe(true);
    expect(formatAtomicAmount(server.available.amountAtomic)).toBe('1000');
    expect(formatAtomicAmount(server.pending.amountAtomic)).toBe('250');
    expect(formatAtomicAmount(server.reserved.amountAtomic)).toBe('75');
  });
});

describe('P12-02 TON Connect ownership', () => {
  it('uses official @tonconnect/ui-react and server challenge/bind endpoints', async () => {
    const panel = await readSrc('components/WalletTonConnectPanel.tsx');
    const screen = await readSrc('components/WalletScreen.tsx');
    const client = await readSrc('lib/api/client.ts');
    expect(panel).toMatch(/@tonconnect\/ui-react/);
    expect(panel).toMatch(/createTonProofChallenge/);
    expect(panel).toMatch(/bindTonProofWallet/);
    expect(panel).toMatch(/setConnectRequestParameters/);
    expect(panel).toMatch(/tonProof/);
    expect(client).toMatch(/\/v1\/wallets\/ton-proof\/challenge/);
    expect(client).toMatch(/\/v1\/wallets\/ton-proof\/bind/);
    expect(screen).toMatch(/TonConnectUIProvider/);
    expect(screen).toMatch(/tonConnectManifestUrl/);
  });

  it('never treats client connection as verified authority', async () => {
    const panel = await readSrc('components/WalletTonConnectPanel.tsx');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(panel).toMatch(/Connection alone is not verification/i);
    expect(panel).not.toMatch(/verified\s*:\s*true/);
    expect(screen).toMatch(/wallet\.verified \? t\('verified'\)/);
    expect(screen).toMatch(/withdrawalCooldownUntil/);
    expect(screen).toMatch(/primaryWalletId|isPrimary/);
  });

  it('degrades honestly when NEXT_PUBLIC_TONCONNECT_MANIFEST_URL is absent', async () => {
    const env = await readSrc('lib/env.ts');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(env).toMatch(/NEXT_PUBLIC_TONCONNECT_MANIFEST_URL/);
    expect(env).toMatch(/Never invents a production/);
    expect(env).toMatch(/return null/);
    expect(screen).toMatch(/manifestUrl === null/);
    expect(screen).toMatch(/connectUnavailableTitle/);
    expect(screen).not.toMatch(/tonconnect-manifest\.json(?!["`])/);
    expect(screen).not.toMatch(/https:\/\/(?!telegram\.org)/);
  });
});

describe('P12-02 withdrawal quote UI', () => {
  it('quotes and confirms via server endpoints without client fee math', async () => {
    const quoteUi = await readSrc('components/WalletWithdrawalQuote.tsx');
    const client = await readSrc('lib/api/client.ts');
    const screen = await readSrc('components/WalletScreen.tsx');
    expect(client).toMatch(/\/v1\/withdrawals\/quote/);
    expect(client).toMatch(/\/v1\/withdrawals'/);
    expect(client).toMatch(/amountAtomic/);
    expect(client).toMatch(/quoteId/);
    expect(client).toMatch(/idempotencyKey/);
    expect(quoteUi).toMatch(/createWithdrawalQuote/);
    expect(quoteUi).toMatch(/createWithdrawal/);
    expect(quoteUi).toMatch(/feeAmountAtomic/);
    expect(quoteUi).toMatch(/netAmountAtomic/);
    expect(quoteUi).toMatch(/expiresAt/);
    expect(quoteUi).not.toMatch(/feeBps\s*=/);
    expect(quoteUi).not.toMatch(/computeNet|platformFee|Math\.(floor|round|ceil)/);
    expect(quoteUi).not.toMatch(/\*\s*0\.\d+/);
    expect(screen).toMatch(/WalletWithdrawalQuote/);
    expect(screen).toMatch(/getWithdrawals/);
  });

  it('displays server-authored quote fields only', () => {
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
    expect(quote.expiresAt).toBe('2026-09-26T12:00:00.000Z');
    expect(isAtomicAmountString(quote.feeAmountAtomic)).toBe(true);
    expect(isAtomicAmountString(quote.netAmountAtomic)).toBe(true);
  });
});
