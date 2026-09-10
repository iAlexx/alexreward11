import { keyPairFromSeed } from '@ton/crypto';
import { describe, expect, it } from 'vitest';

import { SignerError, deriveWalletV5R1 } from '../src/index.js';

describe('Phase 9 Wallet V5 R1', () => {
  it('derives deterministic TESTNET address and rejects MAINNET', () => {
    const kp = keyPairFromSeed(Buffer.alloc(32, 9));
    const a = deriveWalletV5R1({ publicKey: kp.publicKey, networkGlobalId: -3 });
    const b = deriveWalletV5R1({ publicKey: kp.publicKey, networkGlobalId: -3 });
    expect(a.addressRaw).toBe(b.addressRaw);
    expect(a.walletVersion).toBe('v5R1');
    expect(() => deriveWalletV5R1({ publicKey: kp.publicKey, networkGlobalId: -239 })).toThrow(
      SignerError,
    );
  });
});
