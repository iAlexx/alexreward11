import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  admitWalletSeqno,
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
    const stateInit = walletStateInitForSeqno(0, wallet.init);
    expect(stateInit).toBeDefined();
    expect(wallet.address.toRawString().toLowerCase()).toBe(HOT_WALLET_RAW.toLowerCase());
    expect(walletStateInitForSeqno(1, wallet.init)).toBeUndefined();
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
