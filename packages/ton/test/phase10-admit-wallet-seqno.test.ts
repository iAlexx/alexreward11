import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  admitWalletSeqno,
  admitWalletSeqnoWithRateLimitRetry,
  approvedWalletV5R1CodeHash,
  deriveWalletV5R1AddressRaw,
  FakeTonChainProvider,
  TonProviderHttpError,
  walletStateInitForSeqno,
} from '../src/index.js';
import { WalletContractV5R1 } from '@ton/ton';

const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const FINGERPRINT = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});

describe('admitWalletSeqno (fail-closed V5R1)', () => {
  it('admits seqno=0 when both providers independently report uninitialized', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedUninit(HOT_WALLET_RAW);
    secondary.seedUninit(HOT_WALLET_RAW);

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seqno).toBe(0);
    expect(result.accountStatus).toBe('uninit');
    expect(result.requiresStateInit).toBe(true);
    expect(result.derivedAddressRaw.toLowerCase()).toBe(HOT_WALLET_RAW.toLowerCase());
  });

  it('proves first-message StateInit targets the approved address', () => {
    const wallet = WalletContractV5R1.create({
      publicKey: Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'),
      workchain: 0,
      walletId: { networkGlobalId: -3 },
    });
    const stateInit = walletStateInitForSeqno(0, wallet.init, 'uninit');
    expect(stateInit).toBeDefined();
    expect(wallet.address.toRawString().toLowerCase()).toBe(HOT_WALLET_RAW.toLowerCase());
    expect(walletStateInitForSeqno(1, wallet.init, 'uninit')).toBeUndefined();
    expect(walletStateInitForSeqno(0, wallet.init, 'active')).toBeUndefined();
  });

  it('admits active verified V5R1 with seqno=0 without requiring StateInit', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 0,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 0,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seqno).toBe(0);
    expect(result.accountStatus).toBe('active');
    expect(result.requiresStateInit).toBe(false);
  });

  it('BLOCKS uninitialized accounts that report non-null code hash', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedAccountState(HOT_WALLET_RAW, {
      status: 'uninit',
      codeHash: 'ab'.repeat(32),
      balanceNanotons: '1000000000',
    });
    secondary.seedUninit(HOT_WALLET_RAW);

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFLICTING_EVIDENCE');
  });

  it('BLOCKS malformed secondary seqno values (NaN, negative, fractional, unsafe)', async () => {
    const codeHash = approvedWalletV5R1CodeHash({
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      networkGlobalId: -3,
    });
    const cases = [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const bad of cases) {
      const primary = new FakeTonChainProvider();
      const secondary = new FakeTonChainProvider();
      primary.seedAccountState(HOT_WALLET_RAW, { status: 'active', codeHash });
      secondary.seedAccountState(HOT_WALLET_RAW, { status: 'active', codeHash });
      primary.seedSeqno(HOT_WALLET_RAW, 4);
      secondary.seedSeqno(HOT_WALLET_RAW, bad);

      const result = await admitWalletSeqno({
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('MALFORMED_RESPONSE');
    }
  });

  it('admits authoritative seqno for active verified V5R1', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seqno).toBe(7);
    expect(result.accountStatus).toBe('active');
    expect(result.requiresStateInit).toBe(false);
  });

  it('BLOCKS active wallet when TonCenter-style exit_code=-13 (never maps to 0)', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    const codeHash = approvedWalletV5R1CodeHash({
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      networkGlobalId: -3,
    });
    primary.seedAccountState(HOT_WALLET_RAW, { status: 'active', codeHash });
    secondary.seedAccountState(HOT_WALLET_RAW, { status: 'active', codeHash });
    primary.seedSeqnoError(
      HOT_WALLET_RAW,
      new Error('TONCENTER_GET_METHOD_FAILED: TonCenter seqno exit_code=-13'),
    );
    secondary.seedSeqno(HOT_WALLET_RAW, 0);

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SEQNO_UNAVAILABLE');
    expect(result.message).not.toMatch(/admit.*0/i);
  });

  it('BLOCKS unexpected deployed code', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedAccountState(HOT_WALLET_RAW, {
      status: 'active',
      codeHash: 'aa'.repeat(32),
    });
    secondary.seedAccountState(HOT_WALLET_RAW, {
      status: 'active',
      codeHash: 'aa'.repeat(32),
    });
    primary.seedSeqno(HOT_WALLET_RAW, 3);
    secondary.seedSeqno(HOT_WALLET_RAW, 3);

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNEXPECTED_DEPLOYED_CODE');
  });

  it('BLOCKS provider disagreement on account status', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedUninit(HOT_WALLET_RAW);
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 1,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    const result = await admitWalletSeqno({
      networkGlobalId: -3,
      hotWalletAddress: HOT_WALLET_RAW,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      signerKeyReference: FINGERPRINT,
      approvedSignerKeyReference: FINGERPRINT,
      primary,
      secondary,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVIDER_DISAGREEMENT');
  });

  it('BLOCKS rate limit, timeout, and malformed account-state responses', async () => {
    const cases: Array<{ error: Error; code: string }> = [
      { error: new TonProviderHttpError(429, 'slow down', 'TonCenter'), code: 'RATE_LIMITED' },
      { error: new Error('provider timed out'), code: 'TIMEOUT' },
      { error: new Error('MALFORMED_RESPONSE: bad account'), code: 'MALFORMED_RESPONSE' },
    ];
    for (const c of cases) {
      const primary = new FakeTonChainProvider();
      const secondary = new FakeTonChainProvider();
      primary.seedAccountStateError(HOT_WALLET_RAW, c.error);
      secondary.seedUninit(HOT_WALLET_RAW);
      const result = await admitWalletSeqno({
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(c.code);
    }
  });
});

describe('admitWalletSeqnoWithRateLimitRetry', () => {
  it('recovers from transient RATE_LIMITED via full dual-provider re-admission', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 9,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 9,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedTransientAccountStateErrors(HOT_WALLET_RAW, [
      new TonProviderHttpError(429, '{"ok":false,"result":"Ratelimit exceed","code":429}', 'TonCenter getAddressInformation'),
    ]);

    const sleeps: number[] = [];
    const result = await admitWalletSeqnoWithRateLimitRetry(
      {
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      },
      {
        maxAttempts: 3,
        baseDelayMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seqno).toBe(9);
    expect(sleeps).toEqual([25]);
    expect(secondary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(2);
    expect(primary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(2);
  });

  it('fail-closes after persistent RATE_LIMITED without substituting providers', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 1,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 1,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedAccountStateError(
      HOT_WALLET_RAW,
      new TonProviderHttpError(429, 'Ratelimit exceed', 'TonCenter getAddressInformation'),
    );

    const result = await admitWalletSeqnoWithRateLimitRetry(
      {
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleep: async () => undefined,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('RATE_LIMITED');
    expect(secondary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(3);
    expect(primary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(3);
  });

  it('aborts retry when beforeRetry reports lease fence invalid', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 2,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 2,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedAccountStateError(
      HOT_WALLET_RAW,
      new TonProviderHttpError(429, 'slow down', 'TonCenter'),
    );

    let beforeRetryCalls = 0;
    const result = await admitWalletSeqnoWithRateLimitRetry(
      {
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      },
      {
        maxAttempts: 4,
        baseDelayMs: 10,
        sleep: async () => undefined,
        beforeRetry: async () => {
          beforeRetryCalls += 1;
          return {
            ok: false,
            code: 'LEASE_FENCE_INVALID',
            message: 'dispatch lease expired during seqno rate-limit retry',
          };
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LEASE_FENCE_INVALID');
    expect(beforeRetryCalls).toBe(1);
    expect(secondary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(1);
  });

  it('does not retry non-rate-limit provider failures', async () => {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedAccountStateError(HOT_WALLET_RAW, new Error('provider timed out'));
    secondary.seedUninit(HOT_WALLET_RAW);
    const result = await admitWalletSeqnoWithRateLimitRetry(
      {
        networkGlobalId: -3,
        hotWalletAddress: HOT_WALLET_RAW,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        signerKeyReference: FINGERPRINT,
        approvedSignerKeyReference: FINGERPRINT,
        primary,
        secondary,
      },
      { maxAttempts: 4, sleep: async () => undefined },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TIMEOUT');
    expect(primary.getAccountStateCallCount(HOT_WALLET_RAW)).toBe(1);
  });
});

