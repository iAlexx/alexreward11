import { keyPairFromSeed } from '@ton/crypto';
import { describe, expect, it } from 'vitest';

import {
  LocalEphemeralSignPort,
  buildCanonicalSigningMessageAsync,
  type CanonicalPayoutIntent,
} from '../src/index.js';

function sampleIntent(publicKey: Buffer): CanonicalPayoutIntent {
  return {
    publicKey,
    networkGlobalId: -3,
    workchain: 0,
    subwalletNumber: 0,
    seqno: 7,
    validUntil: 1_900_000_000,
    queryId: 42n,
    netAmountAtomic: 1_000_000n,
    recipientAddress: '0:1111111111111111111111111111111111111111111111111111111111111111',
    hotWalletAddress: '0:2222222222222222222222222222222222222222222222222222222222222222',
    payoutJettonWalletAddress: '0:3333333333333333333333333333333333333333333333333333333333333333',
    jettonMasterIdentity: 'TESTNET-SPIKE-USDT-JETTON-MASTER',
  };
}

describe('Phase 9 canonical message determinism', () => {
  it('100 reconstructions are byte-identical and local verify works', async () => {
    const port = new LocalEphemeralSignPort(Buffer.alloc(32, 3));
    const publicKey = await port.getPublicKey();
    const intent = sampleIntent(publicKey);
    const first = await buildCanonicalSigningMessageAsync(intent);
    for (let i = 0; i < 100; i += 1) {
      const next = await buildCanonicalSigningMessageAsync(intent);
      expect(next.canonicalMessageHashHex).toBe(first.canonicalMessageHashHex);
      expect(Buffer.compare(next.signingHash, first.signingHash)).toBe(0);
    }
    const sig = await port.signEd25519RawMessage(first.signingHash);
    expect(sig.length).toBe(64);
  });

  it('field mutation changes canonical hash', async () => {
    const kp = keyPairFromSeed(Buffer.alloc(32, 5));
    const base = sampleIntent(kp.publicKey);
    const a = await buildCanonicalSigningMessageAsync(base);
    const b = await buildCanonicalSigningMessageAsync({ ...base, seqno: base.seqno + 1 });
    const c = await buildCanonicalSigningMessageAsync({
      ...base,
      netAmountAtomic: base.netAmountAtomic + 1n,
    });
    expect(a.canonicalMessageHashHex).not.toBe(b.canonicalMessageHashHex);
    expect(a.canonicalMessageHashHex).not.toBe(c.canonicalMessageHashHex);
  });
});
